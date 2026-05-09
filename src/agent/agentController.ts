import { EventEmitter } from "events";
import { actionProtocolInstructions, parseActionsFromAssistantText, parseToolAction, toolDefinitions } from "../core/actionProtocol";
import { ApprovalQueue } from "../core/approvals";
import { ContextBuilder } from "../core/contextBuilder";
import { OpenAiCompatibleProvider } from "../core/openaiAdapter";
import {
  AgentAction,
  ApprovalRequest,
  ChatMessage,
  LlmProvider,
  ProposePatchAction,
  ProviderCapabilities,
  RunCommandAction,
  WorkspacePort
} from "../core/types";
import { DiffService } from "../adapters/diffService";
import { TerminalRunner } from "../adapters/terminalRunner";
import { CodeForgeConfigService } from "../adapters/vscodeConfig";

export type AgentUiEvent =
  | { readonly type: "sessionReset" }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "message"; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly type: "assistantDelta"; readonly text: string }
  | { readonly type: "toolResult"; readonly text: string }
  | { readonly type: "approvalRequested"; readonly approval: ApprovalRequest }
  | { readonly type: "approvalResolved"; readonly id: string; readonly accepted: boolean; readonly text: string }
  | { readonly type: "error"; readonly text: string };

export class AgentController {
  private readonly config: CodeForgeConfigService;
  private readonly workspace: WorkspacePort;
  private readonly terminal: TerminalRunner;
  private readonly diff: DiffService;
  private readonly events = new EventEmitter();
  private readonly approvals = new ApprovalQueue();
  private readonly capabilityCache = new Map<string, ProviderCapabilities>();
  private messages: ChatMessage[] = [];
  private runningAbort: AbortController | undefined;

  constructor(config: CodeForgeConfigService, workspace: WorkspacePort, terminal: TerminalRunner, diff: DiffService) {
    this.config = config;
    this.workspace = workspace;
    this.terminal = terminal;
    this.diff = diff;
  }

  onEvent(listener: (event: AgentUiEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  reset(): void {
    this.runningAbort?.abort();
    this.runningAbort = undefined;
    this.messages = [];
    this.approvals.clear();
    this.emit({ type: "sessionReset" });
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (this.runningAbort) {
      this.emit({ type: "error", text: "A CodeForge request is already running." });
      return;
    }

    const abort = new AbortController();
    this.runningAbort = abort;
    this.emit({ type: "message", role: "user", text: prompt });

    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      const context = new ContextBuilder(this.workspace, this.config.getContextLimits());
      const contextItems = await context.build(abort.signal);
      this.ensureSystemMessage();
      this.messages.push({
        role: "user",
        content: `${prompt}\n\nWorkspace context:\n\n${context.format(contextItems)}`
      });

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

    try {
      if (approval.action.type === "propose_patch") {
        const changed = await this.diff.applyPatch(approval.action.patch);
        this.emit({
          type: "approvalResolved",
          id,
          accepted: true,
          text: `Applied changes to ${changed.join(", ")}.`
        });
      } else {
        const timeout = this.config.getCommandTimeoutSeconds();
        const result = await this.terminal.run(approval.action, timeout, (stream, text) => {
          this.emit({ type: "toolResult", text: `${stream}: ${text}` });
        });
        this.emit({
          type: "approvalResolved",
          id,
          accepted: true,
          text: `Command exited with ${result.exitCode ?? result.signal ?? "unknown"}${result.timedOut ? " after timeout" : ""}.`
        });
      }
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  reject(id: string): void {
    if (this.approvals.reject(id)) {
      this.emit({ type: "approvalResolved", id, accepted: false, text: "Rejected." });
    }
  }

  private async runModelLoop(provider: LlmProvider, model: string, abort: AbortController): Promise<void> {
    for (let iteration = 0; iteration < 3; iteration++) {
      this.emit({ type: "status", text: `Calling ${provider.profile.label} / ${model}` });
      const capabilities = await this.capabilities(provider, model, abort.signal);
      let assistantText = "";
      const toolActions: AgentAction[] = [];

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
              toolActions.push(action);
            }
          }
        }
      }

      if (assistantText.trim()) {
        this.messages.push({ role: "assistant", content: assistantText });
        this.emit({ type: "message", role: "assistant", text: assistantText });
      }

      const actions = [...toolActions, ...parseActionsFromAssistantText(assistantText)];
      if (actions.length === 0) {
        this.emit({ type: "status", text: "Idle" });
        return;
      }

      const shouldContinue = await this.handleActions(actions);
      if (!shouldContinue) {
        return;
      }
    }

    this.emit({ type: "status", text: "Stopped after the maximum local tool loop count." });
  }

  private async handleActions(actions: readonly AgentAction[]): Promise<boolean> {
    let continuedWithLocalContext = false;
    for (const action of actions) {
      if (action.type === "read_file") {
        const content = await this.workspace.readTextFile(action.path, 48000);
        const result = `read_file ${action.path}\n\n${content}`;
        this.messages.push({ role: "user", content: `CodeForge local tool result:\n\n${result}` });
        this.emit({ type: "toolResult", text: result });
        continuedWithLocalContext = true;
      } else if (action.type === "search_text") {
        const results = await this.workspace.searchText(action.query, 30);
        const result = `search_text ${action.query}\n\n${results.map((item) => `${item.path}:${item.line}: ${item.preview}`).join("\n") || "No matches."}`;
        this.messages.push({ role: "user", content: `CodeForge local tool result:\n\n${result}` });
        this.emit({ type: "toolResult", text: result });
        continuedWithLocalContext = true;
      } else {
        await this.requestApproval(action);
        return false;
      }
    }

    return continuedWithLocalContext;
  }

  private async requestApproval(action: ProposePatchAction | RunCommandAction): Promise<void> {
    const approval = this.approvals.createForAction(action);
    if (action.type === "propose_patch") {
      await this.diff.previewPatch(action.patch);
    }
    this.emit({ type: "approvalRequested", approval });
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

    const models = await provider.listModels(signal);
    if (models.length === 0) {
      throw new Error("No model is configured and the endpoint did not return any models.");
    }
    return models[0];
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

    this.messages.push({
      role: "system",
      content: `${actionProtocolInstructions}\n\nNetwork policy: self-hosted endpoints are first class. Never suggest sending workspace data to an unconfigured public service.`
    });
  }

  private emit(event: AgentUiEvent): void {
    this.events.emit("event", event);
  }
}
