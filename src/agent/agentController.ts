import { EventEmitter } from "events";
import { actionProtocolInstructions, parseActionsFromAssistantText, parseToolAction, toolDefinitions } from "../core/actionProtocol";
import { ApprovalQueue } from "../core/approvals";
import { ContextBuilder } from "../core/contextBuilder";
import { compactOldToolResults } from "../core/contextCompaction";
import { buildContextUsage, ContextUsage, formatBytes } from "../core/contextUsage";
import {
  formatLocalCommandList,
  formatLocalSkillList,
  loadLocalCommands,
  loadLocalHooks,
  loadLocalSkills,
  LocalHook,
  localHookMatches,
  renderLocalCommand,
  renderLocalSkillPrompt
} from "../core/localExtensions";
import { executeLocalReadOnlyTools, LocalToolProgress } from "../core/localToolExecutor";
import { MemoryStore } from "../core/memory";
import { OpenAiCompatibleProvider } from "../core/openaiAdapter";
import { evaluateActionPermission } from "../core/permissions";
import { SessionRecord, SessionSnapshot, SessionStore, SessionSummary } from "../core/session";
import { classifyShellCommand } from "../core/shellSemantics";
import {
  AgentAction,
  ApprovalRequest,
  ChatMessage,
  CommandResult,
  ContextItem,
  ContextLimits,
  LlmProvider,
  ModelInfo,
  OpenAiEndpointInspection,
  PermissionDecision,
  PermissionMode,
  ProviderCapabilities,
  RunCommandAction,
  TokenUsage,
  ToolCall,
  WorkspacePort
} from "../core/types";
import { isApprovalAction, isLocalReadOnlyAction, ToolInvocation, toolSummary, validateAction } from "../core/toolRegistry";
import { DiffService } from "../adapters/diffService";
import { TerminalRunner } from "../adapters/terminalRunner";
import { CodeForgeConfigService, CodeForgeSettingsUpdate } from "../adapters/vscodeConfig";

export type AgentUiEvent =
  | { readonly type: "sessionReset" }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "message"; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly type: "assistantDelta"; readonly text: string }
  | { readonly type: "toolResult"; readonly text: string }
  | { readonly type: "toolUse"; readonly toolUse: AgentToolUse }
  | { readonly type: "sessions"; readonly sessions: readonly AgentSessionSummary[] }
  | { readonly type: "state"; readonly state: AgentUiState }
  | { readonly type: "models"; readonly models: readonly string[]; readonly modelInfo: readonly AgentModelSummary[]; readonly selectedModel: string; readonly backendLabel?: string; readonly error?: string }
  | { readonly type: "contextUsage"; readonly usage: ContextUsage }
  | { readonly type: "openSettings" }
  | { readonly type: "approvalRequested"; readonly approval: ApprovalRequest }
  | { readonly type: "approvalResolved"; readonly id: string; readonly accepted: boolean; readonly text: string }
  | { readonly type: "error"; readonly text: string };

export interface AgentUiState {
  readonly profiles: readonly AgentProfileSummary[];
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeBaseUrl: string;
  readonly selectedModel: string;
  readonly selectedModelInfo?: AgentModelSummary;
  readonly activeBackendLabel?: string;
  readonly models: readonly string[];
  readonly modelInfo: readonly AgentModelSummary[];
  readonly contextUsage: ContextUsage;
  readonly localCommands: readonly AgentLocalCommandSummary[];
  readonly settings: AgentSettingsSummary;
}

export interface AgentProfileSummary {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
}

export interface AgentModelSummary {
  readonly id: string;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly supportsReasoning?: boolean;
}

export interface AgentLocalCommandSummary {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly path: string;
}

export interface AgentSettingsSummary {
  readonly allowlist: readonly string[];
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly commandTimeoutSeconds: number;
  readonly commandOutputLimitBytes: number;
  readonly permissionMode: string;
  readonly permissionRules: readonly unknown[];
}

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "approval";
  readonly readOnly: boolean;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pendingApprovalCount: number;
}

export class AgentController {
  private readonly config: CodeForgeConfigService;
  private readonly workspace: WorkspacePort;
  private readonly terminal: TerminalRunner;
  private readonly diff: DiffService;
  private readonly sessionStore: SessionStore | undefined;
  private readonly memoryStore: MemoryStore | undefined;
  private readonly events = new EventEmitter();
  private readonly approvals = new ApprovalQueue();
  private readonly capabilityCache = new Map<string, ProviderCapabilities>();
  private readonly endpointCache = new Map<string, OpenAiEndpointInspection>();
  private messages: ChatMessage[] = [];
  private lastContextItems: readonly ContextItem[] = [];
  private lastTokenUsage: TokenUsage | undefined;
  private runningAbort: AbortController | undefined;
  private sessionId: string | undefined;
  private sessionStartPromise: Promise<string | undefined> | undefined;

  constructor(
    config: CodeForgeConfigService,
    workspace: WorkspacePort,
    terminal: TerminalRunner,
    diff: DiffService,
    sessionStore?: SessionStore,
    memoryStore?: MemoryStore
  ) {
    this.config = config;
    this.workspace = workspace;
    this.terminal = terminal;
    this.diff = diff;
    this.sessionStore = sessionStore;
    this.memoryStore = memoryStore;
  }

  onEvent(listener: (event: AgentUiEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async initializeSession(): Promise<void> {
    try {
      this.messages = [];
      this.lastContextItems = [];
      this.lastTokenUsage = undefined;
      this.sessionId = undefined;
      this.sessionStartPromise = undefined;
      this.approvals.clear();
      this.emit({ type: "sessionReset" });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: `Failed to initialize session storage: ${errorMessage(error)}` });
    }
  }

  async publishTranscript(): Promise<void> {
    this.emit({ type: "sessionReset" });
    for (const message of this.messages) {
      const event = transcriptEventForMessage(message);
      if (event) {
        this.emit(event);
      }
    }
    for (const approval of this.approvals.list()) {
      this.emit({ type: "approvalRequested", approval });
    }
    this.emitContextUsage();
    await this.publishState();
  }

  async publishState(): Promise<void> {
    this.emit({ type: "state", state: await this.getState() });
  }

  async refreshModels(): Promise<void> {
    try {
      const provider = await this.createProvider();
      const inspection = await provider.inspectEndpoint();
      this.endpointCache.set(provider.profile.id, inspection);
      const models = inspection.models.map((model) => model.id);
      const selectedModel = this.config.getConfiguredModel() || provider.profile.defaultModel || models[0] || "";
      this.emit({
        type: "models",
        models,
        modelInfo: inspection.models.map(toAgentModelSummary),
        selectedModel,
        backendLabel: inspection.backendLabel
      });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      const selectedModel = this.config.getConfiguredModel();
      this.emit({
        type: "models",
        models: [],
        modelInfo: [],
        selectedModel,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.publishState();
    }
  }

  async selectProfile(profileId: string): Promise<void> {
    await this.config.setActiveProfile(profileId);
    this.lastTokenUsage = undefined;
    await this.refreshModels();
  }

  async selectModel(model: string): Promise<void> {
    await this.config.setModel(model);
    this.lastTokenUsage = undefined;
    this.emitContextUsage();
    await this.publishState();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.config.updateSettings({ permissionMode: mode });
    await this.publishState();
  }

  async updateSettings(settings: Partial<CodeForgeSettingsUpdate>): Promise<void> {
    await this.config.updateSettings(settings);
    this.lastTokenUsage = undefined;
    this.emit({ type: "status", text: "Settings saved." });
    await this.refreshModels();
  }

  async compactContext(focus = ""): Promise<void> {
    if (this.runningAbort) {
      this.emit({ type: "error", text: "Wait for the current request to finish before compacting context." });
      return;
    }
    if (this.messages.filter((message) => message.role !== "system").length === 0) {
      this.emit({ type: "status", text: "There is no session context to compact yet." });
      return;
    }

    const abort = new AbortController();
    this.runningAbort = abort;
    this.emit({ type: "status", text: "Compacting context with the selected model." });

    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      const compactMessages: ChatMessage[] = [
        {
          role: "system",
          content: `You compact coding assistant sessions. Preserve user goals, decisions, files discussed, pending work, and important constraints. Return a concise handoff summary only.${focus ? ` Focus especially on: ${focus}` : ""}`
        },
        {
          role: "user",
          content: this.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n")
        }
      ];

      let summary = "";
      for await (const event of provider.streamChat({ model, messages: compactMessages, temperature: 0, signal: abort.signal })) {
        if (event.type === "content") {
          summary += event.text;
        }
      }

      this.replaceMessages([
        this.systemMessage(),
        {
          role: "user",
          content: `Compacted session context:\n\n${summary.trim()}`
        }
      ], "compact");
      await this.publishTranscript();
      this.emit({ type: "message", role: "system", text: "Context compacted with the selected model." });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.runningAbort = undefined;
    }
  }

  reset(): void {
    this.runningAbort?.abort();
    this.runningAbort = undefined;
    this.messages = [];
    this.lastContextItems = [];
    this.lastTokenUsage = undefined;
    this.sessionId = undefined;
    this.sessionStartPromise = undefined;
    this.approvals.clear();
    this.emit({ type: "sessionReset" });
    this.emitContextUsage();
    void this.publishState();
  }

  newSession(): void {
    this.reset();
    this.emit({ type: "status", text: "Started a new chat session for this workspace." });
  }

  cancel(): void {
    if (!this.runningAbort) {
      this.emit({ type: "status", text: "There is no running CodeForge request to stop." });
      return;
    }

    this.runningAbort.abort();
    this.emit({ type: "status", text: "Stopping the current CodeForge request." });
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (prompt.startsWith("/")) {
      await this.handleSlashCommand(prompt);
      return;
    }

    await this.runPrompt(prompt, prompt);
  }

  private async runPrompt(visiblePrompt: string, modelPrompt: string): Promise<void> {
    if (this.runningAbort) {
      this.emit({ type: "error", text: "A CodeForge request is already running." });
      return;
    }

    const abort = new AbortController();
    this.runningAbort = abort;
    this.lastTokenUsage = undefined;
    this.emit({ type: "message", role: "user", text: visiblePrompt });

    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      const memories = await this.memoryStore?.list() ?? [];
      const context = new ContextBuilder(this.workspace, this.effectiveContextLimits(), { memories });
      const contextItems = await context.build(abort.signal);
      const contextText = context.format(contextItems);
      this.lastContextItems = contextItems;
      this.ensureSystemMessage();
      this.appendMessage({
        role: "user",
        content: modelPrompt
      });
      this.appendMessage({
        role: "user",
        content: `CodeForge workspace context:\n\n${contextText}`
      });
      this.emitContextUsage();

      await this.runModelLoop(provider, model, abort);
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.runningAbort = undefined;
    }
  }

  async approve(id: string): Promise<void> {
    const approval = this.approvals.take(id);
    if (!approval) {
      this.emit({ type: "error", text: "That approval request is no longer pending." });
      return;
    }

    const validation = validateAction(approval.action);
    if (!validation.ok) {
      await this.recordApprovalResolved(id, false, validation.message ?? "Stored approval failed validation.");
      this.emit({ type: "approvalResolved", id, accepted: false, text: "Stored approval failed validation." });
      this.emit({ type: "error", text: validation.message ?? "Stored approval failed validation." });
      await this.publishState();
      return;
    }

    await this.recordApprovalResolved(id, true, "Accepted.");
    try {
      const transcriptResult = await this.executePermittedAction(approval.action, approval.toolCallId);
      this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, transcriptResult);
      this.emit({
        type: "approvalResolved",
        id,
        accepted: true,
        text: approvalAcceptedText(approval.action, transcriptResult)
      });
      this.emit({ type: "toolResult", text: transcriptResult });
      this.emitContextUsage();
      await this.publishState();
      void this.continueAfterToolResult();
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async previewApproval(id: string): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval) {
      this.emit({ type: "error", text: "That approval request is no longer pending." });
      return;
    }

    try {
      if (approval.action.type === "propose_patch" || approval.action.type === "open_diff") {
        await this.diff.previewPatch(approval.action.patch);
      } else if (approval.action.type === "write_file") {
        await this.diff.previewWriteFile(approval.action);
      } else if (approval.action.type === "edit_file") {
        await this.diff.previewEditFile(approval.action);
      } else {
        this.emit({ type: "status", text: "This approval does not have a VS Code diff preview." });
        return;
      }
      this.emit({ type: "status", text: "Opened VS Code diff preview." });
    } catch (error) {
      this.emit({ type: "error", text: errorMessage(error) });
    }
  }

  async reject(id: string): Promise<void> {
    const approval = this.approvals.take(id);
    if (approval) {
      const text = `${approval.action.type}\n\nUser rejected this tool request.`;
      await this.recordApprovalResolved(id, false, "Rejected.");
      this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, text);
      this.emit({ type: "approvalResolved", id, accepted: false, text: "Rejected." });
      this.emit({ type: "toolResult", text });
      this.emitContextUsage();
      void this.publishState();
      void this.continueAfterToolResult();
    }
  }

  private async runModelLoop(provider: LlmProvider, model: string, abort: AbortController): Promise<void> {
    for (let iteration = 0; iteration < 3; iteration++) {
      this.compactOldToolResultsIfNeeded();
      this.emit({ type: "status", text: `Calling ${provider.profile.label} / ${model}` });
      const capabilities = await this.capabilities(provider, model, abort.signal);
      let assistantText = "";
      const nativeToolCalls: ToolCall[] = [];
      const invocations: ToolInvocation[] = [];

      this.lastTokenUsage = undefined;
      this.emitContextUsage();
      for await (const event of provider.streamChat({
        model,
        messages: this.messages,
        tools: capabilities.nativeToolCalls ? toolDefinitions : undefined,
        signal: abort.signal
      })) {
        if (event.type === "content") {
          assistantText += event.text;
          this.emit({ type: "assistantDelta", text: event.text });
        } else if (event.type === "toolCalls") {
          for (const toolCall of event.toolCalls) {
            const action = parseToolAction(toolCall.name, toolCall.argumentsJson);
            if (action) {
              nativeToolCalls.push(toolCall);
              invocations.push({
                id: toolCall.id,
                action,
                source: "native",
                toolCallId: toolCall.id
              });
            }
          }
        } else if (event.type === "usage") {
          this.lastTokenUsage = event.usage;
          this.emitContextUsage();
        }
      }

      if (assistantText.trim() || nativeToolCalls.length > 0) {
        this.appendMessage({ role: "assistant", content: assistantText, toolCalls: nativeToolCalls });
        if (assistantText.trim()) {
          this.emit({ type: "message", role: "assistant", text: assistantText });
        }
        this.emitContextUsage();
      }

      const fallbackActions = parseActionsFromAssistantText(assistantText).map((action, index): ToolInvocation => ({
        id: `json-${Date.now()}-${iteration}-${index}`,
        action,
        source: "json"
      }));
      const actions = [...invocations, ...fallbackActions];
      if (actions.length === 0) {
        this.emit({ type: "status", text: "Idle" });
        return;
      }

      const shouldContinue = await this.handleActions(actions);
      if (abort.signal.aborted) {
        this.emit({ type: "status", text: "Stopped." });
        return;
      }
      if (!shouldContinue) {
        return;
      }
    }

    this.emit({ type: "status", text: "Stopped after the maximum local tool loop count." });
  }

  private async handleActions(invocations: readonly ToolInvocation[]): Promise<boolean> {
    let index = 0;
    let continuedWithLocalContext = false;
    const permissionPolicy = this.config.getPermissionPolicy();

    while (index < invocations.length) {
      const localBatch: ToolInvocation[] = [];
      while (index < invocations.length && isLocalReadOnlyAction(invocations[index].action)) {
        const invocation = invocations[index];
        const validation = validateAction(invocation.action);
        if (!validation.ok) {
          this.appendDeniedOrInvalidToolResult(invocation, validation.message ?? "Tool input failed validation.");
          continuedWithLocalContext = true;
          index++;
          continue;
        }

        const decision = evaluateActionPermission(invocation.action, permissionPolicy);
        if (decision.behavior === "deny") {
          this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
          continuedWithLocalContext = true;
          index++;
          continue;
        }
        if (decision.behavior === "ask") {
          await this.requestApproval(invocation.action, invocation.toolCallId, decision);
          this.emitToolUseForInvocation(invocation, "approval", false);
          return false;
        }

        localBatch.push(invocation);
        index++;
      }

      if (localBatch.length > 0) {
        const results = await executeLocalReadOnlyTools(localBatch, {
          workspace: this.workspace,
          readFileMaxBytes: 48000,
          searchLimit: 30,
          signal: this.runningAbort?.signal,
          onProgress: (progress) => this.emitToolProgress(progress)
        });
        for (const result of results) {
          this.appendToolResult(result.invocation.toolCallId, result.invocation.action.type, result.content);
          this.emit({ type: "toolResult", text: result.content });
          this.emitContextUsage();
        }
        continuedWithLocalContext = true;
      }

      if (index >= invocations.length) {
        break;
      }

      const invocation = invocations[index];
      const validation = validateAction(invocation.action);
      if (!validation.ok) {
        this.appendDeniedOrInvalidToolResult(invocation, validation.message ?? "Tool input failed validation.");
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      const decision = evaluateActionPermission(invocation.action, permissionPolicy);
      if (decision.behavior === "deny") {
        this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      if (decision.behavior === "ask") {
        await this.requestApproval(invocation.action, invocation.toolCallId, decision);
        this.emitToolUseForInvocation(invocation, "approval", false);
        return false;
      }

      if (isApprovalAction(invocation.action) || invocation.action.type === "open_diff") {
        const text = await this.executePermittedAction(invocation.action, invocation.toolCallId);
        this.appendToolResult(invocation.toolCallId, invocation.action.type, text);
        this.emit({ type: "toolResult", text });
        this.emitToolUseForInvocation(invocation, "completed", false);
      } else {
        const text = `<tool_use_error>Error: Unsupported tool ${invocation.action.type}</tool_use_error>`;
        this.appendToolResult(invocation.toolCallId, invocation.action.type, text);
        this.emit({ type: "toolResult", text });
      }
      this.emitContextUsage();
      continuedWithLocalContext = true;
      index++;
    }

    return continuedWithLocalContext;
  }

  private async requestApproval(action: AgentAction, toolCallId: string | undefined, decision: PermissionDecision): Promise<void> {
    const approval = this.approvals.createForAction(action, decision, toolCallId, this.approvalMetadata(action, decision));
    if (action.type === "propose_patch") {
      await this.diff.previewPatch(action.patch);
    } else if (action.type === "write_file") {
      await this.diff.previewWriteFile(action);
    } else if (action.type === "edit_file") {
      await this.diff.previewEditFile(action);
    }
    await this.recordApprovalRequested(approval);
    this.emit({ type: "approvalRequested", approval });
  }

  private approvalMetadata(action: AgentAction, decision: PermissionDecision): { readonly detail?: string; readonly risk?: string } {
    if (action.type !== "run_command") {
      return {};
    }

    const semantics = classifyShellCommand(action.command);
    const timeout = this.config.getCommandTimeoutSeconds();
    const outputLimit = this.config.getCommandOutputLimitBytes();
    return {
      risk: [
        semantics.summary,
        semantics.usesNetwork ? "network-capable" : undefined,
        semantics.usesShellExpansion ? "dynamic shell expansion" : undefined
      ].filter((item): item is string => Boolean(item)).join("; "),
      detail: [
        `Command: ${action.command}`,
        `CWD: ${action.cwd?.trim() || "."}`,
        `Timeout: ${timeout}s`,
        `Output limit: ${formatBytes(outputLimit)} per stream`,
        `Permission: ${decision.reason}`,
        `Risk: ${semantics.summary}`,
        semantics.commandNames.length > 0 ? `Detected commands: ${semantics.commandNames.join(", ")}` : undefined,
        semantics.usesNetwork ? "Warning: command can use network-capable tools." : undefined,
        semantics.usesShellExpansion ? "Warning: command uses dynamic shell expansion." : undefined
      ].filter((line): line is string => Boolean(line)).join("\n")
    };
  }

  private appendDeniedOrInvalidToolResult(invocation: ToolInvocation, reason: string): void {
    const text = `<tool_use_error>Error: ${reason}</tool_use_error>`;
    this.emitToolUseForInvocation(invocation, "failed", isLocalReadOnlyAction(invocation.action));
    this.appendToolResult(invocation.toolCallId, invocation.action.type, text);
    this.emit({ type: "toolResult", text });
    this.emitContextUsage();
  }

  private emitToolUseForInvocation(invocation: ToolInvocation, status: AgentToolUse["status"], readOnly: boolean): void {
    this.emit({
      type: "toolUse",
      toolUse: {
        id: invocation.id,
        name: invocation.action.type,
        summary: summaryForInvocation(invocation),
        status,
        readOnly
      }
    });
  }

  private async executePermittedAction(action: AgentAction, toolCallId: string | undefined): Promise<string> {
    await this.runLocalHooks("preTool", action);
    let transcriptResult: string;
    if (isLocalReadOnlyAction(action)) {
      const [result] = await executeLocalReadOnlyTools(
        [{ id: toolCallId ?? `approval-${Date.now()}`, action, source: toolCallId ? "native" : "json", toolCallId }],
        {
          workspace: this.workspace,
          readFileMaxBytes: 48000,
          searchLimit: 30,
          signal: this.runningAbort?.signal,
          onProgress: (progress) => this.emitToolProgress(progress)
        }
      );
      transcriptResult = result.content;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "propose_patch") {
      await this.recordCheckpoint(action, "Before applying proposed patch.");
      const changed = await this.diff.applyPatch(action.patch);
      transcriptResult = `propose_patch\n\nApplied changes to ${changed.join(", ")}.`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "write_file") {
      await this.recordCheckpoint(action, `Before writing ${action.path}.`);
      const changed = await this.diff.applyWriteFile(action);
      transcriptResult = `write_file ${action.path}\n\nWrote ${changed.join(", ")}.`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "edit_file") {
      await this.recordCheckpoint(action, `Before editing ${action.path}.`);
      const changed = await this.diff.applyEditFile(action);
      transcriptResult = `edit_file ${action.path}\n\nEdited ${changed.join(", ")}.`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "open_diff") {
      await this.diff.previewPatch(action.patch);
      transcriptResult = "open_diff\n\nOpened VS Code diff preview.";
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    const timeout = this.config.getCommandTimeoutSeconds();
    await this.recordCheckpoint(action, `Before running ${action.command}.`);
    const result = await this.terminal.run(action, {
      timeoutSeconds: timeout,
      outputLimitBytes: this.config.getCommandOutputLimitBytes(),
      signal: this.runningAbort?.signal
    }, (stream, text) => {
      this.emit({ type: "toolResult", text: `${stream}: ${text}` });
    });
    transcriptResult = formatCommandResult(action, result);
    await this.runLocalHooks("postTool", action);
    return transcriptResult;
  }

  private async runLocalHooks(event: "preTool" | "postTool", action: AgentAction): Promise<void> {
    const hooks = (await loadLocalHooks(this.workspace, this.runningAbort?.signal))
      .filter((hook) => localHookMatches(hook, event, action));
    for (const hook of hooks) {
      await this.runLocalHook(hook, event, action);
    }
  }

  private async runLocalHook(hook: LocalHook, event: "preTool" | "postTool", action: AgentAction): Promise<void> {
    const validation = validateAction(hook.command);
    if (!validation.ok) {
      throw new Error(`Local hook ${hook.name} is invalid: ${validation.message ?? "Command validation failed."}`);
    }

    const decision = evaluateActionPermission(hook.command, this.config.getPermissionPolicy());
    if (decision.behavior !== "allow") {
      throw new Error(`Local hook ${hook.name} cannot run because it is not explicitly allowed by the permission policy. ${decision.reason}`);
    }

    this.emit({
      type: "status",
      text: `Running local ${event} hook ${hook.name} for ${action.type}.`
    });
    const result = await this.terminal.run(hook.command, {
      timeoutSeconds: hook.timeoutSeconds ?? this.config.getCommandTimeoutSeconds(),
      outputLimitBytes: Math.min(this.config.getCommandOutputLimitBytes(), 200000),
      signal: this.runningAbort?.signal
    }, (stream, text) => {
      this.emit({ type: "toolResult", text: `${event} hook ${hook.name} ${stream}: ${text}` });
    });
    const formatted = [
      `local_hook ${hook.name}`,
      "",
      `Event: ${event}`,
      `Tool: ${action.type}`,
      `Path: ${hook.path}`,
      hook.description ? `Description: ${hook.description}` : undefined,
      formatCommandResult(hook.command, result)
    ].filter((line): line is string => Boolean(line)).join("\n");
    this.emit({ type: "toolResult", text: formatted });

    if (result.timedOut || result.cancelled || result.exitCode !== 0) {
      throw new Error(`Local hook ${hook.name} failed for ${action.type}. ${hookFailureStatus(result)}`);
    }
  }

  private async continueAfterToolResult(): Promise<void> {
    if (this.runningAbort) {
      return;
    }

    const abort = new AbortController();
    this.runningAbort = abort;
    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      await this.runModelLoop(provider, model, abort);
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.runningAbort = undefined;
    }
  }

  private appendToolResult(toolCallId: string | undefined, toolName: string, content: string): void {
    this.lastTokenUsage = undefined;
    if (toolCallId) {
      this.appendMessage({ role: "tool", content, name: toolName, toolCallId });
    } else {
      this.appendMessage({ role: "user", content: `CodeForge local tool result:\n\n${content}` });
    }
  }

  private emitToolProgress(progress: LocalToolProgress): void {
    this.emit({
      type: "toolUse",
      toolUse: {
        id: progress.id,
        name: progress.name,
        summary: progress.summary,
        status: progress.status,
        readOnly: progress.readOnly
      }
    });
  }

  private compactOldToolResultsIfNeeded(): void {
    if (this.approvals.list().length > 0) {
      return;
    }

    const result = compactOldToolResults(this.messages, { maxBytes: this.effectiveContextLimits().maxBytes });
    if (result.compactedCount === 0) {
      return;
    }

    this.replaceMessages(result.messages, "compact", true);
    this.emit({
      type: "status",
      text: `Compacted ${result.compactedCount} older tool result(s) to preserve context budget.`
    });
    this.emitContextUsage();
  }

  private async createProvider(): Promise<LlmProvider> {
    const profile = await this.config.getActiveProfile();
    return new OpenAiCompatibleProvider(profile, this.config.getNetworkPolicy());
  }

  private async resolveModel(provider: LlmProvider, signal: AbortSignal): Promise<string> {
    const configured = this.config.getConfiguredModel() || provider.profile.defaultModel;
    if (configured) {
      return configured;
    }

    const inspection = await provider.inspectEndpoint(signal);
    this.endpointCache.set(provider.profile.id, inspection);
    if (inspection.models.length === 0) {
      throw new Error("No model is configured and the endpoint did not return any models.");
    }
    return inspection.models[0].id;
  }

  private async capabilities(provider: LlmProvider, model: string, signal: AbortSignal): Promise<ProviderCapabilities> {
    const key = `${provider.profile.id}:${model}`;
    const cached = this.capabilityCache.get(key);
    if (cached) {
      return cached;
    }

    const capabilities = await provider.probeCapabilities(model, signal);
    this.capabilityCache.set(key, capabilities);
    return capabilities;
  }

  private ensureSystemMessage(): void {
    if (this.messages.some((message) => message.role === "system")) {
      return;
    }

    this.appendMessage(this.systemMessage());
  }

  private systemMessage(): ChatMessage {
    return {
      role: "system",
      content: `${actionProtocolInstructions}\n\nNetwork policy: CodeForge is local/offline first and only talks to configured local or on-prem vLLM/LiteLLM-compatible endpoints. Never suggest sending workspace data to a public service.`
    };
  }

  private appendMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.persistSessionRecord((sessionId) => ({
      type: "message",
      sessionId,
      createdAt: Date.now(),
      message
    }));
  }

  private replaceMessages(messages: readonly ChatMessage[], reason: "compact" | "restore", preserveContextItems = false): void {
    this.messages = [...messages];
    if (!preserveContextItems) {
      this.lastContextItems = [];
    }
    this.lastTokenUsage = undefined;
    this.persistSessionRecord((sessionId) => ({
      type: "messages_replaced",
      sessionId,
      createdAt: Date.now(),
      messages,
      reason
    }));
  }

  private async recordApprovalRequested(approval: ApprovalRequest): Promise<void> {
    await this.appendSessionRecord((sessionId) => ({
      type: "approval_requested",
      sessionId,
      createdAt: Date.now(),
      approval
    }));
  }

  private async recordApprovalResolved(approvalId: string, accepted: boolean, text: string): Promise<void> {
    await this.appendSessionRecord((sessionId) => ({
      type: "approval_resolved",
      sessionId,
      createdAt: Date.now(),
      approvalId,
      accepted,
      text
    }));
  }

  private async recordCheckpoint(action: AgentAction, summary: string): Promise<void> {
    await this.appendSessionRecord((sessionId) => ({
      type: "checkpoint",
      sessionId,
      createdAt: Date.now(),
      action,
      summary
    }));
  }

  private persistSessionRecord(factory: (sessionId: string) => SessionRecord): void {
    void this.appendSessionRecord(factory).catch((error) => {
      this.emit({ type: "error", text: `Failed to persist session record: ${errorMessage(error)}` });
    });
  }

  private async appendSessionRecord(factory: (sessionId: string) => SessionRecord): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const sessionId = await this.ensureSessionId();
    if (!sessionId) {
      return;
    }
    await this.sessionStore.append(factory(sessionId));
  }

  private async ensureSessionId(): Promise<string | undefined> {
    if (!this.sessionStore) {
      return undefined;
    }
    if (this.sessionId) {
      return this.sessionId;
    }
    if (this.sessionStartPromise) {
      return this.sessionStartPromise;
    }
    return this.startNewSession("CodeForge session");
  }

  private async startNewSession(title: string): Promise<string | undefined> {
    if (!this.sessionStore) {
      this.sessionId = undefined;
      this.sessionStartPromise = undefined;
      return undefined;
    }

    this.sessionId = undefined;
    const started = this.sessionStore.createSession(title).then(
      (snapshot) => {
        this.sessionId = snapshot.id;
        this.sessionStartPromise = undefined;
        return snapshot.id;
      },
      (error) => {
        this.sessionStartPromise = undefined;
        throw error;
      }
    );
    this.sessionStartPromise = started;
    return started;
  }

  private applySession(snapshot: SessionSnapshot): void {
    this.sessionId = snapshot.id;
    this.sessionStartPromise = undefined;
    this.messages = [...snapshot.messages];
    this.lastContextItems = [];
    this.lastTokenUsage = undefined;
    this.approvals.restore(snapshot.pendingApprovals);
  }

  private emit(event: AgentUiEvent): void {
    this.events.emit("event", event);
  }

  private async handleSlashCommand(rawPrompt: string): Promise<void> {
    const [commandWithSlash, ...args] = rawPrompt.trim().split(/\s+/);
    const command = commandWithSlash.toLowerCase();
    const rest = args.join(" ");

    switch (command) {
      case "/clear":
      case "/reset":
      case "/new":
        this.reset();
        return;
      case "/stop":
      case "/cancel":
        this.cancel();
        return;
      case "/history":
      case "/sessions":
      case "/chats":
        await this.showSessionHistory();
        return;
      case "/resume":
        await this.resumeSession(rest || undefined);
        return;
      case "/fork":
        await this.forkSession(rest || undefined);
        return;
      case "/diff":
        await this.showSessionDiff(rest || undefined);
        return;
      case "/export":
        await this.exportSession(rest || undefined);
        return;
      case "/compact":
        await this.compactContext(rest);
        return;
      case "/context": {
        this.emit({ type: "message", role: "system", text: this.formatContextReport() });
        this.emitContextUsage();
        return;
      }
      case "/commands":
        await this.showLocalCommands();
        return;
      case "/skills":
        await this.showLocalSkills();
        return;
      case "/skill":
        await this.handleSkillCommand(rest);
        return;
      case "/memory":
        await this.handleMemoryCommand(rest);
        return;
      case "/config":
      case "/settings":
        this.emit({ type: "openSettings" });
        await this.publishState();
        return;
      case "/model":
        if (rest) {
          await this.selectModel(rest);
          this.emit({ type: "message", role: "system", text: `Model set to ${rest}.` });
        } else {
          await this.refreshModels();
          this.emit({ type: "message", role: "system", text: "Refreshed endpoint model list." });
        }
        return;
      default:
        if (await this.tryLocalSlashCommand(command.slice(1), rest, rawPrompt.trim())) {
          return;
        }
        this.emit({
          type: "message",
          role: "system",
          text: `Unknown command ${command}. Available commands: /new, /compact, /context, /commands, /skills, /skill, /memory, /clear, /stop, /history, /resume, /fork, /diff, /export, /model, /config.`
        });
    }
  }

  private async showLocalCommands(): Promise<void> {
    const commands = await loadLocalCommands(this.workspace);
    this.emit({ type: "message", role: "system", text: formatLocalCommandList(commands) });
  }

  private async showLocalSkills(): Promise<void> {
    const skills = await loadLocalSkills(this.workspace);
    this.emit({ type: "message", role: "system", text: formatLocalSkillList(skills) });
  }

  private async handleSkillCommand(rest: string): Promise<void> {
    const [firstRaw, ...tail] = rest.trim().split(/\s+/);
    const first = firstRaw?.toLowerCase() || "";
    if (!first || first === "list") {
      await this.showLocalSkills();
      return;
    }

    const name = first === "use" ? tail.shift()?.toLowerCase() : first;
    const task = (first === "use" ? tail : rest.trim().split(/\s+/).slice(1)).join(" ").trim();
    if (!name) {
      this.emit({ type: "message", role: "system", text: "Usage: /skill <name> <task> or /skill list." });
      return;
    }

    const skills = await loadLocalSkills(this.workspace);
    const skill = skills.find((item) => item.name.toLowerCase() === name);
    if (!skill) {
      this.emit({ type: "message", role: "system", text: `No local CodeForge skill named ${name}.\n\n${formatLocalSkillList(skills)}` });
      return;
    }

    await this.runPrompt(`/skill ${skill.name}${task ? ` ${task}` : ""}`, renderLocalSkillPrompt(skill, task));
  }

  private async tryLocalSlashCommand(name: string, args: string, visiblePrompt: string): Promise<boolean> {
    if (!name) {
      return false;
    }
    const commands = await loadLocalCommands(this.workspace);
    const command = commands.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!command) {
      return false;
    }
    const skills = command.skills.length > 0 ? await loadLocalSkills(this.workspace) : [];
    await this.runPrompt(visiblePrompt, renderLocalCommand(command, args, skills));
    return true;
  }

  private async showSessionHistory(): Promise<void> {
    if (!this.sessionStore) {
      this.emit({ type: "message", role: "system", text: "Session history is not available in this environment." });
      return;
    }

    const sessions = await this.sessionStore.list(10);
    if (sessions.length === 0) {
      this.emit({ type: "message", role: "system", text: "No saved CodeForge sessions." });
      return;
    }

    this.emit({ type: "sessions", sessions: sessions.map(toAgentSessionSummary) });
  }

  async resumeSession(sessionId: string | undefined): Promise<void> {
    if (!this.sessionStore) {
      this.emit({ type: "message", role: "system", text: "Session resume is not available in this environment." });
      return;
    }

    const snapshot = sessionId ? await this.sessionStore.read(sessionId) : await this.sessionStore.readLatest();
    if (!snapshot) {
      this.emit({ type: "error", text: sessionId ? `No saved CodeForge session found for ${sessionId}.` : "No saved CodeForge session found." });
      return;
    }

    this.applySession(snapshot);
    await this.publishTranscript();
    this.emit({ type: "message", role: "system", text: `Resumed session ${snapshot.id}.` });
  }

  private async forkSession(sessionId: string | undefined): Promise<void> {
    if (!this.sessionStore) {
      this.emit({ type: "message", role: "system", text: "Session fork is not available in this environment." });
      return;
    }

    const source = sessionId ? await this.sessionStore.read(sessionId) : undefined;
    if (sessionId && !source) {
      this.emit({ type: "error", text: `No saved CodeForge session found for ${sessionId}.` });
      return;
    }
    const messages = source ? source.messages : this.messages;
    if (messages.length === 0) {
      this.emit({ type: "message", role: "system", text: "There is no session context to fork yet." });
      return;
    }

    this.approvals.clear();
    await this.startNewSession(`Fork of ${source?.title ?? "CodeForge session"}`);
    this.replaceMessages(messages, "restore");
    await this.publishTranscript();
    this.emit({ type: "message", role: "system", text: `Forked session${source ? ` ${source.id}` : ""} into a new local session.` });
  }

  private async showSessionDiff(sessionId: string | undefined): Promise<void> {
    if (!this.sessionStore) {
      this.emit({ type: "message", role: "system", text: "Session diff history is not available in this environment." });
      return;
    }

    const snapshot = await this.resolveStoredSession(sessionId);
    if (!snapshot) {
      this.emit({ type: "error", text: sessionId ? `No saved CodeForge session found for ${sessionId}.` : "No saved CodeForge session found." });
      return;
    }

    const checkpoints = snapshot.records.filter(isCheckpointRecord);
    if (checkpoints.length === 0) {
      this.emit({ type: "message", role: "system", text: `No edit or command checkpoints recorded for ${snapshot.id}.` });
      return;
    }

    const lines = checkpoints.map((record, index) => {
      return `${index + 1}. ${new Date(record.createdAt).toLocaleString()} | ${record.summary} | ${toolSummary(record.action)}`;
    });
    this.emit({ type: "message", role: "system", text: `Checkpoints for ${snapshot.id}:\n${lines.join("\n")}` });
  }

  private async exportSession(sessionId: string | undefined): Promise<void> {
    if (!this.sessionStore) {
      this.emit({ type: "message", role: "system", text: "Session export is not available in this environment." });
      return;
    }

    const snapshot = await this.resolveStoredSession(sessionId);
    if (!snapshot) {
      this.emit({ type: "error", text: sessionId ? `No saved CodeForge session found for ${sessionId}.` : "No saved CodeForge session found." });
      return;
    }

    const exportedPath = await this.sessionStore.exportSession(snapshot.id);
    if (!exportedPath) {
      this.emit({ type: "error", text: `Failed to export ${snapshot.id}.` });
      return;
    }
    this.emit({ type: "message", role: "system", text: `Exported ${snapshot.id} to ${exportedPath}.` });
  }

  private async resolveStoredSession(sessionId: string | undefined): Promise<SessionSnapshot | undefined> {
    if (!this.sessionStore) {
      return undefined;
    }
    if (sessionId) {
      return this.sessionStore.read(sessionId);
    }
    if (this.sessionId) {
      return this.sessionStore.read(this.sessionId);
    }
    return this.sessionStore.readLatest();
  }

  private formatContextReport(): string {
    const usage = this.currentContextUsage();
    const lines = [
      `Context usage: ${usage.label} (${usage.percent}%).`,
      "",
      "Breakdown:",
      ...usage.breakdown.map((part) => `- ${part.label}: ${formatBytes(part.bytes)} (${part.percent}%)`)
    ];

    if (this.lastContextItems.length > 0) {
      lines.push("", "Last attached local context:");
      for (const item of this.lastContextItems) {
        lines.push(`- ${contextItemKindLabel(item.kind)}: ${item.label} (${formatBytes(Buffer.byteLength(item.content, "utf8"))})`);
      }
    } else {
      lines.push("", "Last attached local context: none yet in this session.");
    }

    return lines.join("\n");
  }

  private async handleMemoryCommand(rest: string): Promise<void> {
    if (!this.memoryStore) {
      this.emit({ type: "message", role: "system", text: "Local memory is not available in this environment." });
      return;
    }

    const [subcommandRaw, ...args] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "list";
    const value = args.join(" ").trim();

    switch (subcommand) {
      case "add":
      case "remember": {
        if (!value) {
          this.emit({ type: "message", role: "system", text: "Usage: /memory add <local instruction or preference>" });
          return;
        }
        const memory = await this.memoryStore.add(value);
        this.emit({ type: "message", role: "system", text: `Saved local memory ${memory.id}.` });
        return;
      }
      case "remove":
      case "forget":
      case "delete": {
        if (!value) {
          this.emit({ type: "message", role: "system", text: "Usage: /memory remove <memory-id>" });
          return;
        }
        const removed = await this.memoryStore.remove(value);
        this.emit({ type: "message", role: "system", text: removed ? `Removed local memory ${value}.` : `No local memory found for ${value}.` });
        return;
      }
      case "clear":
        await this.memoryStore.clear();
        this.emit({ type: "message", role: "system", text: "Cleared all local CodeForge memories." });
        return;
      case "list": {
        const memories = await this.memoryStore.list();
        if (memories.length === 0) {
          this.emit({ type: "message", role: "system", text: "No local CodeForge memories are saved." });
          return;
        }
        const lines = memories.map((memory) => `${memory.id} | ${new Date(memory.createdAt).toLocaleString()} | ${memory.text}`);
        this.emit({ type: "message", role: "system", text: `Local CodeForge memories:\n${lines.join("\n")}` });
        return;
      }
      default:
        this.emit({ type: "message", role: "system", text: "Usage: /memory list, /memory add <text>, /memory remove <id>, or /memory clear." });
    }
  }

  private async getState(): Promise<AgentUiState> {
    const activeProfile = await this.config.getActiveProfile();
    const contextLimits = this.config.getContextLimits();
    const networkPolicy = this.config.getNetworkPolicy();
    const permissionPolicy = this.config.getPermissionPolicy();
    const profiles = this.config.getProfiles().map((profile): AgentProfileSummary => ({
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      hasApiKey: Boolean(profile.apiKeySecretName)
    }));
    const inspection = this.endpointCache.get(activeProfile.id);
    const modelInfo = inspection?.models.map(toAgentModelSummary) ?? [];
    const models = modelInfo.map((model) => model.id);
    const selectedModel = this.config.getConfiguredModel() || activeProfile.defaultModel || models[0] || "";
    const selectedModelInfo = modelInfo.find((model) => model.id === selectedModel);
    return {
      profiles,
      activeProfileId: activeProfile.id,
      activeProfileLabel: activeProfile.label,
      activeBaseUrl: activeProfile.baseUrl,
      selectedModel,
      selectedModelInfo,
      activeBackendLabel: inspection?.backendLabel,
      models,
      modelInfo,
      contextUsage: this.currentContextUsage(),
      localCommands: await this.localCommandSummaries(),
      settings: {
        allowlist: networkPolicy.allowlist,
        maxFiles: contextLimits.maxFiles,
        maxBytes: contextLimits.maxBytes,
        commandTimeoutSeconds: this.config.getCommandTimeoutSeconds(),
        commandOutputLimitBytes: this.config.getCommandOutputLimitBytes(),
        permissionMode: permissionPolicy.mode,
        permissionRules: permissionPolicy.rules
      }
    };
  }

  private async localCommandSummaries(): Promise<readonly AgentLocalCommandSummary[]> {
    try {
      const commands = await loadLocalCommands(this.workspace);
      return commands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        path: command.path
      }));
    } catch {
      return [];
    }
  }

  private emitContextUsage(): void {
    this.emit({ type: "contextUsage", usage: this.currentContextUsage() });
  }

  private currentContextUsage(): ContextUsage {
    const limits = this.effectiveContextLimits();
    const selectedModel = this.selectedModelInfo();
    const maxTokens = selectedModel?.contextLength
      ? Math.max(1, Math.floor(selectedModel.contextLength * 0.8))
      : undefined;
    return buildContextUsage(this.messages, limits.maxBytes, this.lastContextItems, {
      actualTokenUsage: this.lastTokenUsage,
      maxTokens
    });
  }

  private effectiveContextLimits(): ContextLimits {
    const configured = this.config.getContextLimits();
    const selectedModel = this.selectedModelInfo();
    if (!selectedModel?.contextLength) {
      return configured;
    }

    const usableTokens = Math.max(1024, Math.floor(selectedModel.contextLength * 0.8));
    return {
      ...configured,
      maxBytes: Math.max(8000, usableTokens * 4)
    };
  }

  private selectedModelInfo(): ModelInfo | undefined {
    const activeProfileId = this.config.getActiveProfileId();
    const inspection = this.endpointCache.get(activeProfileId);
    if (!inspection) {
      return undefined;
    }

    const profile = this.config.getProfiles().find((item) => item.id === activeProfileId);
    const selectedModel = this.config.getConfiguredModel() || profile?.defaultModel || inspection.models[0]?.id || "";
    return inspection.models.find((model) => model.id === selectedModel);
  }
}

function toAgentModelSummary(model: ModelInfo): AgentModelSummary {
  return {
    id: model.id,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    supportsReasoning: model.supportsReasoning
  };
}

function toAgentSessionSummary(session: SessionSummary): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    pendingApprovalCount: session.pendingApprovalCount
  };
}

function transcriptEventForMessage(message: ChatMessage): AgentUiEvent | undefined {
  if (message.role === "system") {
    return undefined;
  }
  if (message.role === "assistant") {
    return message.content.trim() ? { type: "message", role: "assistant", text: message.content } : undefined;
  }
  if (message.role === "tool") {
    return { type: "toolResult", text: message.content };
  }

  const localToolPrefix = "CodeForge local tool result:\n\n";
  if (message.content.startsWith(localToolPrefix)) {
    return { type: "toolResult", text: message.content.slice(localToolPrefix.length) };
  }

  if (message.content.startsWith("CodeForge workspace context:\n\n")) {
    return undefined;
  }

  const compactPrefix = "Compacted session context:\n\n";
  if (message.content.startsWith(compactPrefix)) {
    return { type: "message", role: "system", text: message.content };
  }

  return { type: "message", role: "user", text: stripWorkspaceContext(message.content) };
}

function stripWorkspaceContext(content: string): string {
  return content.split("\n\nWorkspace context:\n\n", 1)[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCheckpointRecord(record: SessionRecord): record is Extract<SessionRecord, { readonly type: "checkpoint" }> {
  return record.type === "checkpoint";
}

function contextItemKindLabel(kind: ContextItem["kind"]): string {
  switch (kind) {
    case "activeFile":
      return "Active file";
    case "projectInstructions":
      return "Project instructions";
    case "memory":
      return "Local memory";
    case "selection":
      return "Active selection";
    case "openFile":
      return "Open file";
    case "fileTree":
      return "Workspace file list";
    case "file":
      return "Workspace file";
  }
}

function formatCommandResult(action: RunCommandAction, result: CommandResult): string {
  const status = result.timedOut
    ? `timed out after command timeout`
    : result.cancelled
      ? "cancelled by user"
    : `exited with ${result.exitCode ?? result.signal ?? "unknown"}`;
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `run_command ${action.command}`,
    "",
    `CWD: ${result.cwd}`,
    `Status: ${status}`,
    `Duration: ${Math.max(0, result.endedAt - result.startedAt)}ms`,
    `Output limit: ${formatBytes(result.outputLimitBytes)} per stream`,
    result.stdoutTruncated ? "STDOUT was truncated to the configured output limit." : undefined,
    stdout ? `STDOUT:\n${stdout}` : "STDOUT: (empty)",
    result.stderrTruncated ? "STDERR was truncated to the configured output limit." : undefined,
    stderr ? `STDERR:\n${stderr}` : "STDERR: (empty)"
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function hookFailureStatus(result: CommandResult): string {
  if (result.timedOut) {
    return "Command timed out.";
  }
  if (result.cancelled) {
    return "Command was cancelled.";
  }
  return `Command exited with ${result.exitCode ?? result.signal ?? "unknown"}.`;
}

function approvalAcceptedText(action: AgentAction, transcriptResult: string): string {
  switch (action.type) {
    case "list_files":
      return "Listed files.";
    case "glob_files":
      return `Found files matching ${action.pattern}.`;
    case "read_file":
      return `Read ${action.path}.`;
    case "search_text":
      return `Searched for ${action.query}.`;
    case "grep_text":
      return `Searched for ${action.query}.`;
    case "list_diagnostics":
      return action.path ? `Listed diagnostics for ${action.path}.` : "Listed workspace diagnostics.";
    case "write_file":
      return `Wrote ${action.path}.`;
    case "edit_file":
      return `Edited ${action.path}.`;
    case "open_diff":
      return "Opened diff preview.";
    case "propose_patch":
      return transcriptResult.split("\n").find((line) => line.startsWith("Applied changes")) ?? "Applied proposed edit.";
    case "run_command": {
      const status = transcriptResult.split("\n").find((line) => line.startsWith("Status:"));
      return status ? `Command ${status.slice("Status: ".length)}.` : "Command finished.";
    }
  }
}

function summaryForInvocation(invocation: ToolInvocation): string {
  try {
    return toolSummary(invocation.action);
  } catch {
    return invocation.action.type;
  }
}
