import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { compactOldToolResults as runToolResultCompaction } from "../core/contextCompaction";
import { buildContextUsage, ContextUsage } from "../core/contextUsage";
import { resolveRequestMaxTokens } from "../core/openaiAdapter";
import { ChatMessage, ContextItem, ContextLimits, LlmProvider, LlmRequest, LlmStreamEvent, ModelInfo, TokenUsage } from "../core/types";
import type { AgentUiEvent } from "./agentUiTypes";
import { errorMessage } from "./toolText";

const contextAutoCompactPercent = 80;
const contextAttachmentRatio = 0.55;
const contextToolResultTargetRatio = 0.6;

export interface ContextManagerDeps {
  readonly config: CodeForgeConfigService;
  getMessages(): readonly ChatMessage[];
  replaceMessages(messages: readonly ChatMessage[], reason: "compact" | "restore", preserveContextItems?: boolean): void;
  getLastContextItems(): readonly ContextItem[];
  getLastTokenUsage(): TokenUsage | undefined;
  selectedModelInfo(): ModelInfo | undefined;
  resolveAuxiliaryModel(provider: LlmProvider, signal: AbortSignal, fallbackModel?: string): Promise<string>;
  streamChatWithIdleTimeout(provider: LlmProvider, request: LlmRequest, abort: AbortController, purpose: string): AsyncIterable<LlmStreamEvent>;
  systemMessage(): ChatMessage;
  approvalsCount(): number;
  emit(event: AgentUiEvent): void;
  publishState(): Promise<void>;
  publishTranscript(): Promise<void>;
}

// Owns context-budget accounting and compaction (model-driven summarization + deterministic
// old-tool-result trimming). Operates on the controller's transcript through getMessages/replaceMessages
// — the controller still owns the message buffer and the run lifecycle.
export class ContextManager {
  constructor(private readonly deps: ContextManagerDeps) {}

  // -- Budget accounting --------------------------------------------------------------------------

  currentUsage(): ContextUsage {
    return buildContextUsage(this.deps.getMessages(), this.contextWindowMaxBytes(), this.deps.getLastContextItems(), {
      actualTokenUsage: this.deps.getLastTokenUsage(),
      maxTokens: this.contextWindowMaxTokens()
    });
  }

  emitUsage(): void {
    this.deps.emit({ type: "contextUsage", usage: this.currentUsage() });
  }

  effectiveContextLimits(): ContextLimits {
    const configured = this.deps.config.getContextLimits();
    const maxTokens = this.contextWindowMaxTokens();
    if (!maxTokens) {
      return configured;
    }
    const usableTokens = Math.max(1024, Math.floor(maxTokens * contextAttachmentRatio));
    return { ...configured, maxBytes: Math.max(8000, usableTokens * 4) };
  }

  contextWindowMaxTokens(): number | undefined {
    return this.deps.config.getContextLimits().maxTokens ?? this.deps.selectedModelInfo()?.contextLength;
  }

  // Bound on generated tokens for every model turn, honoring codeforge.model.maxOutputTokens
  // (0 = no limit, >=1 = cap; defaults to 32k, safely bounded). Returns undefined when no limit.
  requestMaxTokens(): number | undefined {
    return resolveRequestMaxTokens(
      this.deps.selectedModelInfo(),
      this.deps.config.getContextLimits().maxTokens,
      this.deps.config.getMaxOutputTokensPreference()
    );
  }

  private contextWindowMaxBytes(): number {
    const maxTokens = this.contextWindowMaxTokens();
    return maxTokens ? Math.max(8000, maxTokens * 4) : this.deps.config.getContextLimits().maxBytes;
  }

  hasCompactableContext(): boolean {
    return this.deps.getMessages().filter((message) => message.role !== "system").length > 0;
  }

  // True when the live context is at/over the auto-compact threshold, there is something to compact,
  // and no approval is blocking. Lets a caller cheaply gate an expensive provider/model setup before
  // deciding to compact — e.g. right after a model switch shrinks the context window.
  shouldAutoCompact(): boolean {
    return this.currentUsage().percent >= contextAutoCompactPercent
      && this.deps.approvalsCount() === 0
      && this.hasCompactableContext();
  }

  // -- Compaction ---------------------------------------------------------------------------------

  // Run a model turn that replaces the transcript with a concise handoff summary.
  async compact(provider: LlmProvider, model: string, abort: AbortController, focus = ""): Promise<void> {
    const compactMessages: ChatMessage[] = [
      {
        role: "system",
        content: `You compact coding assistant sessions. Preserve user goals, decisions, files discussed, pending work, and important constraints. Return a concise handoff summary only.${focus ? ` Focus especially on: ${focus}` : ""}`
      },
      {
        role: "user",
        content: this.deps.getMessages().map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n")
      }
    ];

    let summary = "";
    for await (const event of this.deps.streamChatWithIdleTimeout(provider, { model, messages: compactMessages, temperature: 0, maxTokens: this.requestMaxTokens(), signal: abort.signal }, abort, "Context compaction")) {
      if (event.type === "content") {
        summary += event.text;
      }
    }

    this.deps.replaceMessages([
      this.deps.systemMessage(),
      {
        role: "user",
        content: `Compacted session context:\n\n${summary.trim()}`
      }
    ], "compact");
  }

  // Auto-compact when usage crosses the threshold — skipped while approvals are pending or there is
  // nothing to compact. Uses the auxiliary model when configured.
  async autoCompactIfNeeded(provider: LlmProvider, model: string, abort: AbortController, phase: string): Promise<void> {
    const usage = this.currentUsage();
    if (usage.percent < contextAutoCompactPercent || this.deps.approvalsCount() > 0 || !this.hasCompactableContext()) {
      return;
    }

    this.deps.emit({ type: "status", text: `Auto-compacting context at ${usage.percent}% ${phase}.` });
    try {
      const compactModel = this.deps.config.getAuxiliaryModel()
        ? await this.deps.resolveAuxiliaryModel(provider, abort.signal, model)
        : model;
      await this.compact(provider, compactModel, abort, `Automatic compaction at ${usage.percent}% context usage.`);
      await this.deps.publishTranscript();
      this.deps.emit({ type: "message", role: "system", text: `Context auto-compacted at ${usage.percent}%.` });
      this.emitUsage();
      await this.deps.publishState();
    } catch (error) {
      this.deps.emit({ type: "error", text: `Auto-compaction failed: ${errorMessage(error)}` });
    }
  }

  // Deterministically trim old tool results when the budget is tight (no model call).
  compactOldToolResults(): void {
    if (this.deps.approvalsCount() > 0) {
      return;
    }
    const result = runToolResultCompaction(this.deps.getMessages(), {
      maxBytes: this.contextWindowMaxBytes(),
      triggerRatio: contextAutoCompactPercent / 100,
      targetRatio: contextToolResultTargetRatio
    });
    if (result.compactedCount === 0) {
      return;
    }
    this.deps.replaceMessages(result.messages, "compact", true);
    this.deps.emit({
      type: "status",
      text: `Compacted ${result.compactedCount} older tool result(s) to preserve context budget.`
    });
    this.emitUsage();
  }
}
