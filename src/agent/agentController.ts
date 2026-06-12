import { EventEmitter } from "events";
import { actionProtocolInstructions, parseActionsFromAssistantText, parseToolActionDetailed, ToolActionParseResult, toolDefinitions } from "../core/actionProtocol";
import { ApprovalQueue } from "../core/approvals";
import { CodeIntelPort, UnavailableCodeIntelPort } from "../core/codeIntel";
import { ContextBuilder } from "../core/contextBuilder";
import { compactOldToolResults } from "../core/contextCompaction";
import { buildContextUsage, ContextUsage, formatBytes } from "../core/contextUsage";
import { DoctorCheck, formatDoctorReport, worstDoctorStatus } from "../core/doctor";
import { EndpointCapabilityStore, isFreshCapability } from "../core/endpointCapabilityCache";
import {
  formatLocalCommandList,
  formatLocalAgentList,
  formatLocalSkillList,
  loadLocalCommands,
  loadLocalAgents,
  loadLocalHooks,
  loadLocalSkills,
  loadLocalSoul,
  LocalAgent,
  LocalHook,
  localHookMatches,
  renderLocalCommand,
  renderLocalSkillPrompt
} from "../core/localExtensions";
import { executeLocalReadOnlyTools, LocalToolProgress } from "../core/localToolExecutor";
import { formatSkillsDigest } from "../core/skills";
import { MemoryStore } from "../core/memory";
import { MemoryManager } from "./memoryManager";
import { MemoryProvider } from "../core/memoryProvider";
import { BuiltinMemoryProvider } from "../core/builtinMemoryProvider";
import { memoryStoreNoteStore } from "../core/memoryStoreNoteStore";
import { archivedSkillDirPath, skillDirPath, SkillIo } from "../core/skillIo";
import { SkillManager } from "../core/skillManager";
import { SkillUsageReportRow, SkillUsageTracker } from "../core/skillUsage";
import { buildReviewPrompt, REVIEW_TOOL_HINT } from "../core/backgroundReview";
import {
  applyAutomaticTransitions,
  CURATOR_REVIEW_PROMPT,
  formatCandidateList,
  formatTransitionSummary,
  parseCuratorSummary,
  readCuratorState,
  shouldRunCurator,
  writeCuratorState
} from "../core/curator";
import { listBackups, rollbackSkills, snapshotSkills } from "../core/curatorBackup";
import { NotebookPort, UnavailableNotebookPort } from "../core/notebooks";
import {
  callConfiguredMcpTool,
  configuredMcpServerStatuses,
  inspectConfiguredMcpServers,
  McpResourceSummary,
  McpServerInspection,
  McpServerStatus,
  McpToolSummary,
  readConfiguredMcpResource
} from "../core/mcpClient";
import { isUrlAllowed } from "../core/networkPolicy";
import { OpenAiCompatibleProvider, resolveRequestMaxTokens } from "../core/openaiAdapter";
import { evaluateActionPermission, permissionModeLabel } from "../core/permissions";
import { SessionRecord, SessionSnapshot, SessionStore, SessionSummary } from "../core/session";
import { classifyShellCommand } from "../core/shellSemantics";
import { normalizeWorkspacePathInput } from "../core/workspacePaths";
import {
  AgentAction,
  AgentMode,
  ApprovalRequest,
  ChatMessage,
  CodeForgeTask,
  CommandResult,
  ContextItem,
  ContextLimits,
  LlmRequest,
  LlmProvider,
  LlmStreamEvent,
  ModelInfo,
  OpenAiEndpointInspection,
  PermissionDecision,
  PermissionMode,
  ProviderCapabilities,
  ProviderProfile,
  RunCommandAction,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  UserQuestion,
  WorkspaceDiagnostic,
  WorkspacePort
} from "../core/types";
import { codeForgeTools, isApprovalAction, isConcurrencySafeAction, isLocalReadOnlyAction, isReadOnlyAction, ToolInvocation, toolSummary, validateAction } from "../core/toolRegistry";
import { buildWorkspaceIndex } from "../core/workspaceIndex";
import { DiffService } from "../adapters/diffService";
import { TerminalRunner } from "../adapters/terminalRunner";
import { CodeForgeConfigService, CodeForgeSettingsUpdate } from "../adapters/vscodeConfig";
import { WorkerManager } from "./workerManager";
import { findWorkerDefinition, isWorkerKind, workerCommandList } from "../core/workerAgents";
import { WorkerDefinition, WorkerSummary } from "../core/workerTypes";

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
  | { readonly type: "mcpProbe"; readonly inspections: readonly AgentMcpInspectionSummary[] }
  | { readonly type: "contextUsage"; readonly usage: ContextUsage }
  | { readonly type: "workers"; readonly workers: readonly AgentWorkerSummary[] }
  | { readonly type: "inspector"; readonly inspector: AgentInspectorSummary }
  | { readonly type: "openSettings" }
  | { readonly type: "approvalRequested"; readonly approval: ApprovalRequest }
  | { readonly type: "approvalResolved"; readonly id: string; readonly accepted: boolean; readonly text: string }
  | { readonly type: "error"; readonly text: string }
  | { readonly type: "runComplete"; readonly reason: "idle" | "awaitingApproval" };

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
  readonly mcpServers: readonly AgentMcpServerStatusSummary[];
  readonly mcpContext: readonly AgentMcpResourceContextSummary[];
  readonly workers: readonly AgentWorkerSummary[];
  readonly activeContext: AgentActiveContextSummary;
  readonly memories: readonly AgentMemorySummary[];
  readonly capabilityCache: readonly AgentCapabilitySummary[];
  readonly inspector: AgentInspectorSummary;
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

export interface AgentMcpServerStatusSummary {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: string;
  readonly target: string;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface AgentMcpToolSummary {
  readonly name: string;
  readonly description?: string;
}

export interface AgentMcpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface AgentMcpInspectionSummary {
  readonly server: AgentMcpServerStatusSummary;
  readonly tools: readonly AgentMcpToolSummary[];
  readonly resources: readonly AgentMcpResourceSummary[];
  readonly error?: string;
}

export interface AgentMcpResourceContextSummary {
  readonly serverId: string;
  readonly uri: string;
  readonly label: string;
  readonly bytes: number;
}

export interface AgentSettingsSummary {
  readonly agentMode: string;
  readonly allowlist: readonly string[];
  readonly maxFiles: number;
  readonly maxTokens?: number;
  readonly maxBytes: number;
  readonly commandTimeoutSeconds: number;
  readonly modelIdleTimeoutSeconds: number;
  readonly streamCompletionGraceSeconds: number;
  readonly maxInvalidToolCallRetries: number;
  readonly commandOutputLimitBytes: number;
  readonly permissionMode: string;
  readonly permissionRules: readonly unknown[];
  readonly mcpServers: readonly unknown[];
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

export type AgentWorkerSummary = WorkerSummary;

export interface AgentActiveContextSummary {
  readonly activeFile?: string;
  readonly workspaceReady: boolean;
  readonly pinnedFiles: readonly string[];
}

export interface AgentMemorySummary {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly scope: string;
  readonly namespace?: string;
}

export interface AgentCapabilitySummary {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly backendLabel?: string;
  readonly nativeToolCalls: boolean;
  readonly streaming: boolean;
  readonly modelListing: boolean;
  readonly contextLength?: number;
  readonly supportsReasoning?: boolean;
  readonly checkedAt: number;
}

export interface AgentInspectorSummary {
  readonly entries: readonly AgentInspectorEntry[];
  readonly audit: readonly AgentAuditEntry[];
}

export interface AgentInspectorEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly level: "info" | "warn" | "error";
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface AgentAuditEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly action: string;
  readonly behavior: PermissionDecision["behavior"];
  readonly source: PermissionDecision["source"];
  readonly reason: string;
  readonly outcome: "allowed" | "approval" | "denied" | "accepted" | "rejected" | "failed";
  readonly summary: string;
}

const maxAgentToolTurns = 25;
const maxReadOnlyToolTurns = 12;
const workerJoinTimeoutMs = 900_000;
const contextAutoCompactPercent = 80;
const contextAttachmentRatio = 0.55;
const contextToolResultTargetRatio = 0.6;
const defaultModelStreamIdleTimeoutMs = 300_000;
const queuedWorkLimit = 20;
const codeForgeToolSchemaMarker = "CODEFORGE_TOOL_SCHEMA_LOADED:";
const mcpToolSchemaMarker = "CODEFORGE_MCP_TOOL_SCHEMA_LOADED:";

interface QueuedPrompt {
  readonly type: "prompt";
  readonly visiblePrompt: string;
  readonly modelPrompt: string;
}

interface QueuedCompact {
  readonly type: "compact";
  readonly focus: string;
}

interface PendingContinuation {
  readonly prompt?: string;
  readonly statusText: string;
  readonly remainingInvocations?: readonly ToolInvocation[];
}

type QueuedWork = QueuedPrompt | QueuedCompact;

const coreAgentToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "tool_list",
  "ask_user_question",
  "spawn_agent",
  "worker_output",
  "open_diff",
  "propose_patch",
  "write_file",
  "edit_file",
  "run_command"
]);

const coreReadOnlyToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "tool_list",
  "ask_user_question",
  "worker_output"
]);

interface InvalidNativeToolCall {
  readonly toolCall: ToolCall;
  readonly message: string;
}

interface McpToolBinding {
  readonly serverId: string;
  readonly toolName: string;
}

interface ToolSchemaSearchResult {
  readonly name: string;
  readonly score: number;
  readonly content: string;
}

interface ReadFileSnapshot {
  readonly content: string;
  readonly maxBytes: number;
  readonly readAt: number;
  readonly source: "tool" | "worker";
}

export class AgentController {
  private readonly config: CodeForgeConfigService;
  private readonly workspace: WorkspacePort;
  private readonly terminal: TerminalRunner;
  private readonly diff: DiffService;
  private readonly sessionStore: SessionStore | undefined;
  private readonly memoryStore: MemoryStore | undefined;
  private readonly codeIntel: CodeIntelPort;
  private readonly notebooks: NotebookPort;
  private readonly providerFactory: (() => LlmProvider | Promise<LlmProvider>) | undefined;
  private readonly endpointCapabilityStore: EndpointCapabilityStore | undefined;
  private readonly workers: WorkerManager;
  private readonly events = new EventEmitter();
  private readonly approvals = new ApprovalQueue();
  private readonly workerApprovalWaiters = new Map<string, { readonly workerId: string; readonly resolve: (text: string) => void }>();
  private readonly approvalContinuations = new Map<string, readonly ToolInvocation[]>();
  private readonly capabilityCache = new Map<string, ProviderCapabilities>();
  private readonly endpointCache = new Map<string, OpenAiEndpointInspection>();
  private readonly selectedModelByProfile = new Map<string, string>();
  // Dedup keys (`${profileId}:${configuredId}`) for the one-time "configured model not in list" warning.
  private readonly warnedUnmatchedModels = new Set<string>();
  // Dedup keys (`${profileId}:${selectedId}`) for the visible "selected model is currently unavailable"
  // chat notice. Cleared for a model once it is seen available again so a later disappearance re-warns.
  private readonly unavailableModelNoticed = new Set<string>();
  private readonly readFileState = new Map<string, ReadFileSnapshot>();
  private readonly notebookReadState = new Set<string>();
  private messages: ChatMessage[] = [];
  private tasks = new Map<string, CodeForgeTask>();
  private lastContextItems: readonly ContextItem[] = [];
  private mcpContextItems: ContextItem[] = [];
  private pinnedFiles = new Set<string>();
  private inspectorEntries: AgentInspectorEntry[] = [];
  private auditEntries: AgentAuditEntry[] = [];
  private lastTokenUsage: TokenUsage | undefined;
  private runningAbort: AbortController | undefined;
  private continueAfterCurrentRun = false;
  private pendingContinuation: PendingContinuation | undefined;
  private queuedWork: QueuedWork[] = [];
  private sessionId: string | undefined;
  private sessionStartPromise: Promise<string | undefined> | undefined;
  private soulText: string | undefined;
  private memoryManager: MemoryManager | undefined;
  private memoryInitialized = false;
  private skillManager: SkillManager | undefined;
  private skillUsage: SkillUsageTracker | undefined;
  private skillIo: SkillIo | undefined;
  private curatorInFlight = false;
  // True while a background self-improvement review fork is running, so skills it creates are
  // marked curator-eligible (created_by: "agent").
  private inBackgroundReview = false;
  private reviewInFlight = false;
  // Cadence counters for the background self-improvement review (memory ~every N user turns, skills
  // ~every N tool iterations). Cumulative counters + last-reviewed markers avoid reset races.
  private userTurnCount = 0;
  private toolIterationCount = 0;
  private lastMemoryReviewTurnCount = 0;
  private lastSkillReviewIterationCount = 0;
  private lastReviewedMessageCount = 0;

  constructor(
    config: CodeForgeConfigService,
    workspace: WorkspacePort,
    terminal: TerminalRunner,
    diff: DiffService,
    sessionStore?: SessionStore,
    memoryStore?: MemoryStore,
    codeIntel: CodeIntelPort = new UnavailableCodeIntelPort(),
    notebooks: NotebookPort = new UnavailableNotebookPort(),
    providerFactory?: () => LlmProvider | Promise<LlmProvider>,
    endpointCapabilityStore?: EndpointCapabilityStore,
    skillIo?: SkillIo,
    externalMemoryProvider?: MemoryProvider
  ) {
    this.config = config;
    this.workspace = workspace;
    this.terminal = terminal;
    this.diff = diff;
    this.sessionStore = sessionStore;
    this.memoryStore = memoryStore;
    this.codeIntel = codeIntel;
    this.notebooks = notebooks;
    this.providerFactory = providerFactory;
    this.endpointCapabilityStore = endpointCapabilityStore;
    if (memoryStore) {
      const memorySettings = config.getMemorySettings();
      // Reserve core tool names against rogue external providers — but NOT the tools that ARE
      // memory-provider tools (memory/fact_store/fact_feedback are registered in the core registry
      // for schema/parse/dispatch yet owned by a provider).
      const providerOwnedTools = new Set(["memory", "fact_store", "fact_feedback"]);
      const reservedToolNames = new Set(toolDefinitions.map((tool) => tool.name).filter((name) => !providerOwnedTools.has(name)));
      this.memoryManager = new MemoryManager(reservedToolNames);
      this.memoryManager.addProvider(new BuiltinMemoryProvider(memoryStoreNoteStore(memoryStore), {
        memoryCharLimit: memorySettings.memoryCharLimit,
        userCharLimit: memorySettings.userCharLimit
      }));
      if (externalMemoryProvider && externalMemoryProvider.isAvailable()) {
        this.memoryManager.addProvider(externalMemoryProvider);
      }
    }
    if (skillIo) {
      this.skillIo = skillIo;
      this.skillUsage = new SkillUsageTracker(skillIo);
      this.skillManager = new SkillManager(skillIo, this.skillUsage);
    }
    this.workers = new WorkerManager({
      workspace: this.workspace,
      contextLimits: () => this.effectiveContextLimits(),
      maxConcurrentWorkers: () => this.config.getWorkersMaxConcurrent(),
      skillsDigest: (_definition, prompt) => this.workerSkillsDigest(prompt),
      mcpResources: () => this.mcpContextItems,
      createProvider: () => this.createProvider(),
      resolveModel: (provider, signal) => this.resolveModel(provider, signal),
      capabilities: (provider, model, signal) => this.capabilities(provider, model, signal),
      selectedModelInfo: () => this.selectedModelInfo(),
      requestMaxTokens: () => this.requestMaxTokens(),
      permissionPolicy: () => this.config.getPermissionPolicy(),
      executeAction: (action, toolCallId, worker) => this.executeWorkerAction(action, toolCallId, worker),
      onReadFile: (path, content, maxBytes) => this.rememberReadFile(path, content, maxBytes, "worker"),
      record: (factory) => this.persistSessionRecord(factory),
      onDidChange: (workers) => this.emit({ type: "workers", workers }),
      onNotice: (message) => this.emit({ type: "message", role: "system", text: message })
    });
  }

  onEvent(listener: (event: AgentUiEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async initializeSession(): Promise<void> {
    try {
      const latest = await this.sessionStore?.readLatest();
      if (latest) {
        this.applySession(latest);
      } else {
        this.messages = [];
        this.tasks.clear();
        this.lastContextItems = [];
        this.mcpContextItems = [];
        this.pinnedFiles.clear();
        this.readFileState.clear();
        this.notebookReadState.clear();
        this.inspectorEntries = [];
        this.auditEntries = [];
        this.lastTokenUsage = undefined;
        this.sessionId = undefined;
        this.sessionStartPromise = undefined;
        this.memoryInitialized = false;
        this.workers.clear();
        this.approvals.clear();
        this.workerApprovalWaiters.clear();
      }
      this.continueAfterCurrentRun = false;
      this.pendingContinuation = undefined;
      this.emit({ type: "sessionReset" });
      this.emitInspector();
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
    this.emit({ type: "workers", workers: this.workers.list() });
    this.emitContextUsage();
    await this.publishState();
  }

  async publishState(): Promise<void> {
    this.emit({ type: "state", state: await this.getState() });
  }

  async listSessions(limit = 50): Promise<readonly AgentSessionSummary[]> {
    if (!this.sessionStore) {
      return [];
    }
    return (await this.sessionStore.list(limit)).map(toAgentSessionSummary);
  }

  getCurrentSessionId(): string | undefined {
    return this.sessionId;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.sessionStore) {
      this.emit({ type: "error", text: "Session history is not available in this environment." });
      return false;
    }
    if (!sessionId) {
      this.emit({ type: "error", text: "Select a CodeForge session to delete." });
      return false;
    }
    if (this.runningAbort && this.sessionId === sessionId) {
      this.emit({ type: "error", text: "Stop the current CodeForge request before deleting the active conversation." });
      return false;
    }

    const deleted = await this.sessionStore.deleteSession(sessionId);
    if (!deleted) {
      this.emit({ type: "error", text: `No saved CodeForge session found for ${sessionId}.` });
      return false;
    }

    if (this.sessionId === sessionId) {
      this.reset();
    } else {
      await this.publishState();
    }
    this.emit({ type: "status", text: `Deleted conversation ${sessionId}.` });
    return true;
  }

  async refreshModels(): Promise<void> {
    try {
      const provider = await this.createProvider();
      const inspection = await provider.inspectEndpoint();
      this.endpointCache.set(provider.profile.id, inspection);
      const models = inspection.models.map((model) => model.id);
      const selectedModel = this.selectedModelFor(provider.profile, inspection);
      // Seed the per-profile selection from the resolved id (canonical when matched, configured id
      // when not) so that every later selectedModelFor/resolveModel call short-circuits to the same
      // value the dropdown is showing — no dropdown toggle required to make display and request agree.
      if (selectedModel && !this.selectedModelByProfile.has(provider.profile.id)) {
        this.selectedModelByProfile.set(provider.profile.id, selectedModel);
      }
      this.notifyIfSelectedModelUnavailable(provider.profile, inspection);
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

  async runDoctor(): Promise<void> {
    if (this.runningAbort) {
      this.emit({ type: "status", text: "CodeForge is busy. Run /stop to cancel the active operation before starting Doctor." });
      return;
    }

    const abort = new AbortController();
    const checks: DoctorCheck[] = [];
    this.runningAbort = abort;
    this.emit({ type: "status", text: "Running CodeForge Doctor." });

    try {
      const profile = await this.config.getActiveProfile();
      const networkPolicy = this.config.getNetworkPolicy();
      const endpointPolicy = isUrlAllowed(profile.baseUrl, networkPolicy);
      checks.push({
        category: "Endpoint",
        name: "Network policy",
        status: endpointPolicy.allowed ? "pass" : "fail",
        detail: endpointPolicy.allowed
          ? `${originLabel(profile.baseUrl)} is allowed by the local/offline endpoint policy.`
          : endpointPolicy.reason ?? `${profile.baseUrl} is blocked by the local/offline endpoint policy.`,
        recommendation: endpointPolicy.allowed ? undefined : "Save the endpoint URL in CodeForge settings to allow that exact origin."
      });

      if (endpointPolicy.allowed) {
        await this.addEndpointDoctorChecks(checks, abort.signal);
      } else {
        checks.push({
          category: "Endpoint",
          name: "Endpoint inspection",
          status: "fail",
          detail: "Skipped because the active OpenAI API endpoint is blocked by network policy."
        });
      }

      await this.addWorkspaceDoctorChecks(checks, abort.signal);
      this.addPermissionDoctorChecks(checks);
      this.addMcpDoctorChecks(checks);
      this.addPersistenceDoctorChecks(checks);
      this.addToolingDoctorChecks(checks);
    } catch (error) {
      checks.push({
        category: "Doctor",
        name: "Unexpected error",
        status: "fail",
        detail: errorMessage(error)
      });
    } finally {
      this.clearRunningAbort(abort);
      this.drainQueuedWork();
    }

    const result = worstDoctorStatus(checks);
    this.emit({ type: "message", role: "system", text: formatDoctorReport(checks) });
    this.emit({
      type: "status",
      text: result === "pass" ? "Doctor passed." : result === "warn" ? "Doctor completed with warnings." : "Doctor found blocking issues."
    });
    this.emitContextUsage();
    await this.publishState();
  }

  private async addEndpointDoctorChecks(checks: DoctorCheck[], signal: AbortSignal): Promise<void> {
    let provider: LlmProvider;
    let inspection: OpenAiEndpointInspection;
    try {
      provider = await this.createProvider();
      inspection = await provider.inspectEndpoint(signal);
      this.endpointCache.set(provider.profile.id, inspection);
      checks.push({
        category: "Endpoint",
        name: "Backend detection",
        status: "pass",
        detail: `${inspection.backendLabel} at ${originLabel(provider.profile.baseUrl)}.`
      });
    } catch (error) {
      checks.push({
        category: "Endpoint",
        name: "Endpoint inspection",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Confirm the OpenAI API compatible endpoint is running and reachable from VS Code."
      });
      return;
    }

    checks.push({
      category: "Endpoint",
      name: "Model discovery",
      status: inspection.models.length > 0 ? "pass" : "fail",
      detail: inspection.models.length > 0
        ? `${inspection.models.length} model(s) returned by /v1/models.`
        : "The endpoint returned no models from /v1/models.",
      recommendation: inspection.models.length > 0 ? undefined : "Load a model in the selected OpenAI API compatible server."
    });

    if (inspection.models.length === 0) {
      return;
    }

    const configuredModel = this.config.getConfiguredModel() || provider.profile.defaultModel || "";
    const selectedModel = this.selectedModelFor(provider.profile, inspection);
    const selectedModelInfo = inspection.models.find((model) => model.id === selectedModel);
    const configuredModelFound = !configuredModel || inspection.models.some((model) => model.id === configuredModel);
    checks.push({
      category: "Endpoint",
      name: "Selected model",
      status: selectedModel && configuredModelFound ? "pass" : "warn",
      detail: configuredModelFound
        ? `Using ${selectedModel}.`
        : `Configured model ${configuredModel} was not returned by /v1/models; using ${selectedModel}.`,
      recommendation: configuredModelFound ? undefined : "Select a model returned by the active endpoint."
    });

    checks.push({
      category: "Endpoint",
      name: "Context metadata",
      status: selectedModelInfo?.contextLength ? "pass" : "warn",
      detail: selectedModelInfo?.contextLength
        ? `${selectedModel} reports ${selectedModelInfo.contextLength.toLocaleString("en-US")} context tokens${selectedModelInfo.supportsReasoning ? " and thinking/reasoning support" : ""}.`
        : `${selectedModel} did not expose context length metadata in /v1/models.`,
      recommendation: selectedModelInfo?.contextLength ? undefined : "Expose a context-length field from the OpenAI API compatible endpoint when possible — e.g. max_model_len (vLLM), n_ctx or n_ctx_train (llama.cpp, under meta), context_length (OpenRouter/Together), context_window (Groq), max_context_length (LM Studio/Mistral), or max_input_tokens/max_tokens (LiteLLM). CodeForge detects any of these, at the top level or nested."
    });

    try {
      const capabilities = await this.capabilities(provider, selectedModel, signal);
      checks.push({
        category: "Endpoint",
        name: "Native tool calls",
        status: capabilities.nativeToolCalls ? "pass" : "warn",
        detail: capabilities.nativeToolCalls
          ? `${selectedModel} accepted OpenAI-style tool calls.`
          : `${selectedModel} did not accept native tool calls; CodeForge will use JSON action fallback.`,
        recommendation: capabilities.nativeToolCalls ? undefined : "Use a model/server combination with OpenAI tool-call support for the most reliable agent loop."
      });
      checks.push({
        category: "Endpoint",
        name: "Streaming",
        status: capabilities.streaming ? "pass" : "warn",
        detail: capabilities.streaming ? "Streaming chat responses are available." : "Streaming responses were not confirmed."
      });
    } catch (error) {
      checks.push({
        category: "Endpoint",
        name: "Capability probe",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Check that /v1/chat/completions accepts the selected model and OpenAI-compatible request bodies."
      });
    }
  }

  private async addWorkspaceDoctorChecks(checks: DoctorCheck[], signal: AbortSignal): Promise<void> {
    try {
      const files = await this.workspace.listTextFiles(5, signal);
      checks.push({
        category: "Repo Folder",
        name: "File discovery",
        status: files.length > 0 ? "pass" : "warn",
        detail: files.length > 0
          ? `Repo search can see files including ${files.slice(0, 3).join(", ")}.`
          : "No repo text files were returned.",
        recommendation: files.length > 0 ? undefined : "Open the repo folder before asking CodeForge to inspect code."
      });
    } catch (error) {
      checks.push({
        category: "Repo Folder",
        name: "File discovery",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Check VS Code trust and filesystem access for the open repo folder."
      });
    }
  }

  private addPermissionDoctorChecks(checks: DoctorCheck[]): void {
    const policy = this.config.getPermissionPolicy();
    const readDecision = evaluateActionPermission({ type: "read_file", path: "README.md" }, policy);
    const writeDecision = evaluateActionPermission({ type: "write_file", path: "codeforge-doctor.txt", content: "diagnostic\n" }, policy);
    const commandDecision = evaluateActionPermission({ type: "run_command", command: "npm test" }, policy);
    checks.push({
      category: "Permissions",
      name: "Approval mode",
      status: readDecision.behavior === "deny" ? "fail" : "pass",
      detail: `${permissionModeLabel(policy.mode)} mode: read_file=${readDecision.behavior}, write_file=${writeDecision.behavior}, run_command=${commandDecision.behavior}.`,
      recommendation: readDecision.behavior === "deny" ? "Remove deny rules that block read_file if the model should understand the codebase." : undefined
    });
  }

  private addMcpDoctorChecks(checks: DoctorCheck[]): void {
    const statuses = configuredMcpServerStatuses(this.config.getMcpServers(), this.config.getNetworkPolicy());
    if (statuses.length === 0) {
      checks.push({
        category: "MCP",
        name: "Configured servers",
        status: "pass",
        detail: "No MCP servers configured. MCP is optional and only uses explicitly configured servers."
      });
      return;
    }

    for (const status of statuses) {
      checks.push({
        category: "MCP",
        name: status.label,
        status: !status.enabled || status.valid ? "pass" : "fail",
        detail: status.enabled
          ? status.valid
            ? `${status.transport} ${status.target} is configured.`
            : status.reason ?? `${status.transport} ${status.target} is invalid.`
          : `${status.transport} ${status.target} is disabled.`,
        recommendation: status.enabled && !status.valid ? "Fix or remove this MCP server configuration." : undefined
      });
    }
  }

  private addPersistenceDoctorChecks(checks: DoctorCheck[]): void {
    checks.push({
      category: "Persistence",
      name: "Repo chat history",
      status: this.sessionStore ? "pass" : "warn",
      detail: this.sessionStore ? "Repo-scoped chat sessions are available." : "Session storage is not available in this environment."
    });
    checks.push({
      category: "Persistence",
      name: "Local memory",
      status: this.memoryStore ? "pass" : "warn",
      detail: this.memoryStore ? "Persistent local memory is available." : "Persistent local memory is not available in this environment."
    });
  }

  private addToolingDoctorChecks(checks: DoctorCheck[]): void {
    checks.push({
      category: "Tooling",
      name: "Internal tools",
      status: "pass",
      detail: `${codeForgeTools.length} internal tools are registered with deferred schema loading via tool_search.`
    });
  }

  async selectProfile(profileId: string): Promise<void> {
    await this.config.setActiveProfile(profileId);
    this.lastTokenUsage = undefined;
    await this.refreshModels();
  }

  async selectModel(model: string): Promise<void> {
    const profileId = this.config.getActiveProfileId();
    this.selectedModelByProfile.set(profileId, model);
    await this.config.setModel(model);
    this.lastTokenUsage = undefined;
    this.emit({ type: "status", text: `Model set to ${model}.` });
    this.emitContextUsage();
    await this.publishState();
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    await this.config.setAgentMode(mode);
    this.emit({ type: "status", text: `Agent mode set to ${agentModeLabel(mode)}.` });
    await this.publishState();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    try {
      await this.config.updateSettings({ permissionMode: mode });
    } finally {
      // Always re-publish from the persisted policy so the picker label reflects what actually took
      // effect — never the optimistic value the webview showed before this round-trip. If the write
      // failed, this corrects the label back to the real mode before the error propagates.
      await this.publishState();
    }
    const applied = this.config.getPermissionPolicy().mode;
    this.emit({ type: "message", role: "system", text: `Permission mode set to ${permissionModeLabel(applied)}.` });
  }

  async pinActiveFile(): Promise<void> {
    const active = await this.workspace.getActiveTextDocument(1);
    if (!active || active.label.startsWith("Unsaved active")) {
      this.emit({ type: "error", text: "Focus a repo file to pin it, or use /pin <repo-relative path>." });
      return;
    }
    await this.pinFile(active.label);
  }

  async pinFile(path: string): Promise<void> {
    const normalized = path.trim().replace(/^Pinned:\s*/, "");
    if (!normalized) {
      this.emit({ type: "error", text: "Provide a repo-relative file path to pin." });
      return;
    }
    try {
      await this.workspace.readTextFile(normalized, 1);
      this.pinnedFiles.add(normalized);
      this.emit({ type: "status", text: `Pinned ${normalized} for future context.` });
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: `Could not pin ${normalized}: ${errorMessage(error)}` });
    }
  }

  async unpinFile(path?: string): Promise<void> {
    if (!path || path.trim().toLowerCase() === "all") {
      this.pinnedFiles.clear();
      this.emit({ type: "status", text: "Cleared pinned context files." });
      await this.publishState();
      return;
    }
    const normalized = path.trim().replace(/^Pinned:\s*/, "");
    const removed = this.pinnedFiles.delete(normalized);
    this.emit({ type: removed ? "status" : "error", text: removed ? `Unpinned ${normalized}.` : `${normalized} was not pinned.` });
    await this.publishState();
  }

  async addMemory(text: string, scope: "workspace" | "user" | "agent" = "workspace", namespace?: string): Promise<void> {
    if (!this.memoryStore) {
      this.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    try {
      const memory = await this.memoryStore.add(text, { scope, namespace });
      this.recordInspector("info", "memory", `Saved ${scope} memory ${memory.id}.`, memory.text);
      this.emit({ type: "status", text: `Saved local memory ${memory.id}.` });
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: errorMessage(error) });
    }
  }

  async updateMemory(id: string, text: string, scope: "workspace" | "user" | "agent" = "workspace", namespace?: string): Promise<void> {
    if (!this.memoryStore) {
      this.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    try {
      const memory = await this.memoryStore.update(id, text, { scope, namespace });
      if (!memory) {
        this.emit({ type: "error", text: `No local memory found for ${id}.` });
        return;
      }
      this.recordInspector("info", "memory", `Updated ${scope} memory ${memory.id}.`, memory.text);
      this.emit({ type: "status", text: `Updated local memory ${memory.id}.` });
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: errorMessage(error) });
    }
  }

  async removeMemory(id: string): Promise<void> {
    if (!this.memoryStore) {
      this.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    const removed = await this.memoryStore.remove(id);
    this.emit({ type: removed ? "status" : "error", text: removed ? `Removed local memory ${id}.` : `No local memory found for ${id}.` });
    await this.publishState();
  }

  async clearMemories(): Promise<void> {
    if (!this.memoryStore) {
      this.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    await this.memoryStore.clear();
    this.emit({ type: "status", text: "Cleared all local CodeForge memories." });
    await this.publishState();
  }

  async updateSettings(settings: Partial<CodeForgeSettingsUpdate>): Promise<void> {
    await this.config.updateSettings(settings);
    this.lastTokenUsage = undefined;
    this.emit({ type: "status", text: "Settings saved." });
    await this.refreshModels();
  }

  async inspectMcpServers(serverId?: string, servers = this.config.getMcpServers()): Promise<void> {
    const inspections = await inspectConfiguredMcpServers(
      servers,
      this.config.getNetworkPolicy(),
      serverId,
      this.runningAbort?.signal
    );
    this.emit({ type: "mcpProbe", inspections: inspections.map(toAgentMcpInspectionSummary) });
    await this.publishState();
  }

  async compactContext(focus = ""): Promise<void> {
    if (this.runningAbort) {
      this.queueCompact(focus);
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
      await this.compactSessionWithProvider(provider, model, abort, focus);
      await this.publishTranscript();
      this.emit({ type: "message", role: "system", text: "Context compacted with the selected model." });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.clearRunningAbort(abort);
      this.drainQueuedWork();
    }
  }

  private async autoCompactContextIfNeeded(provider: LlmProvider, model: string, abort: AbortController, phase: string): Promise<void> {
    const usage = this.currentContextUsage();
    if (usage.percent < contextAutoCompactPercent || this.approvals.list().length > 0 || this.messages.filter((message) => message.role !== "system").length === 0) {
      return;
    }

    this.emit({ type: "status", text: `Auto-compacting context at ${usage.percent}% ${phase}.` });
    try {
      await this.compactSessionWithProvider(provider, model, abort, `Automatic compaction at ${usage.percent}% context usage.`);
      await this.publishTranscript();
      this.emit({ type: "message", role: "system", text: `Context auto-compacted at ${usage.percent}%.` });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: `Auto-compaction failed: ${errorMessage(error)}` });
    }
  }

  private async compactSessionWithProvider(provider: LlmProvider, model: string, abort: AbortController, focus = ""): Promise<void> {
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
    for await (const event of this.streamChatWithIdleTimeout(provider, { model, messages: compactMessages, temperature: 0, maxTokens: this.requestMaxTokens(), signal: abort.signal }, abort, "Context compaction")) {
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
  }

  private async *streamChatWithIdleTimeout(
    provider: LlmProvider,
    request: LlmRequest,
    abort: AbortController,
    purpose: string
  ): AsyncIterable<LlmStreamEvent> {
    const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
    const idleTimeoutMs = modelStreamIdleTimeoutMs(this.config.getModelIdleTimeoutSeconds());
    const statusIntervalMs = 10_000;
    let lastActivityAt = Date.now();

    try {
      let nextResult = iterator.next();
      while (true) {
        if (abort.signal.aborted) {
          throw new Error(`${purpose} was stopped.`);
        }

        let timeout: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: ReturnType<typeof setTimeout> | undefined;
        const remainingBeforeTimeoutMs = Math.max(1, idleTimeoutMs - (Date.now() - lastActivityAt));
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abort.abort();
            reject(new Error(`${purpose} timed out because the model stream was idle for ${formatDuration(idleTimeoutMs)}.`));
          }, remainingBeforeTimeoutMs);
        });
        const heartbeatPromise = new Promise<"heartbeat">((resolve) => {
          heartbeat = setTimeout(() => resolve("heartbeat"), statusIntervalMs);
        });

        let result: IteratorResult<LlmStreamEvent> | "heartbeat";
        try {
          result = await Promise.race([nextResult, timeoutPromise, heartbeatPromise]);
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
          if (heartbeat) {
            clearTimeout(heartbeat);
          }
        }

        if (result === "heartbeat") {
          const idleMs = Date.now() - lastActivityAt;
          const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
          this.emit({ type: "status", text: `${purpose} still waiting on ${provider.profile.label}: ${formatDuration(idleMs)} idle, ${formatDuration(remainingMs)} before timeout.` });
          continue;
        }

        if (result.done) {
          return;
        }
        lastActivityAt = Date.now();
        nextResult = iterator.next();
        yield result.value;
      }
    } catch (error) {
      void iterator.return?.().catch(() => undefined);
      throw error;
    }
  }

  reset(): void {
    this.runningAbort?.abort();
    this.runningAbort = undefined;
    this.messages = [];
    this.tasks.clear();
    this.lastContextItems = [];
    this.mcpContextItems = [];
    this.pinnedFiles.clear();
    this.readFileState.clear();
    this.notebookReadState.clear();
    this.inspectorEntries = [];
    this.auditEntries = [];
    this.lastTokenUsage = undefined;
    this.sessionId = undefined;
    this.sessionStartPromise = undefined;
    this.workers.clear();
    this.approvals.clear();
    this.workerApprovalWaiters.clear();
    this.approvalContinuations.clear();
    this.continueAfterCurrentRun = false;
    this.pendingContinuation = undefined;
    this.queuedWork = [];
    this.memoryInitialized = false;
    this.reviewInFlight = false;
    this.userTurnCount = 0;
    this.toolIterationCount = 0;
    this.lastMemoryReviewTurnCount = 0;
    this.lastSkillReviewIterationCount = 0;
    this.lastReviewedMessageCount = 0;
    this.emit({ type: "sessionReset" });
    this.emitInspector();
    this.emitContextUsage();
    void this.publishState();
  }

  newSession(): void {
    this.reset();
    this.emit({ type: "status", text: "Started a new chat session for this repo." });
  }

  cancel(): void {
    if (!this.runningAbort) {
      this.emit({ type: "status", text: "There is no running CodeForge request to stop." });
      return;
    }

    this.runningAbort.abort();
    this.emit({ type: "status", text: "Stopping the current CodeForge request." });
  }

  stopWorker(workerId: string): void {
    const stopped = this.workers.stop(workerId);
    this.emit({
      type: stopped ? "status" : "error",
      text: stopped ? `Stopped worker ${workerId}.` : `No running worker found for ${workerId}.`
    });
  }

  showWorkerOutput(workerId: string): void {
    const output = this.workers.output(workerId);
    if (output) {
      this.emit({ type: "message", role: "system", text: output });
    } else {
      this.emit({ type: "error", text: `No worker found for ${workerId}.` });
    }
  }

  attachWorkerOutput(workerId: string): void {
    const output = this.workers.output(workerId);
    if (!output) {
      this.emit({ type: "error", text: `No worker found for ${workerId}.` });
      return;
    }
    this.appendMessage({
      role: "user",
      content: `CodeForge attached worker output for future model context:\n\n${output}`
    });
    this.emit({ type: "message", role: "system", text: `Attached worker output ${workerId} to this chat context.` });
    this.emitContextUsage();
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (prompt.startsWith("/")) {
      await this.handleSlashCommand(prompt);
      return;
    }

    await this.runPrompt(prompt, prompt);
  }

  private async runPrompt(visiblePrompt: string, modelPrompt: string, queueIfBusy = true): Promise<void> {
    if (this.runningAbort) {
      if (queueIfBusy) {
        this.queuePrompt(visiblePrompt, modelPrompt);
      } else {
        this.queuedWork.unshift({ type: "prompt", visiblePrompt, modelPrompt });
        this.emit({ type: "status", text: "Queued prompt until the current CodeForge operation finishes." });
      }
      return;
    }

    const abort = new AbortController();
    this.runningAbort = abort;
    this.lastTokenUsage = undefined;
    this.recordInspector("info", "run", `Started ${agentModeLabel(this.config.getAgentMode())} request.`, visiblePrompt);
    this.emit({ type: "message", role: "user", text: visiblePrompt });
    this.userTurnCount += 1;

    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      await this.autoCompactContextIfNeeded(provider, model, abort, "before request");
      const context = new ContextBuilder(this.workspace, this.effectiveContextLimits(), { mcpResources: this.mcpContextItems, pinnedFiles: [...this.pinnedFiles] });
      const contextItems = await context.build(abort.signal);
      const contextText = context.format(contextItems);
      this.lastContextItems = contextItems;
      this.recordInspector("info", "context", `Attached ${contextItems.length} context item(s).`, contextItems.map((item) => `${contextItemKindLabel(item.kind)}: ${item.label}`).join("\n"));
      this.soulText = await loadLocalSoul(this.workspace, abort.signal);
      // Build the curated-notes snapshot once per session before the system prompt is assembled, so
      // it stays byte-stable (prefix cache) for the whole session.
      await this.ensureMemoryInitialized();
      this.ensureSystemMessage();
      this.appendMessage({
        role: "user",
        content: modelPrompt
      });
      // Recalled durable memory (from an external provider, when configured) is injected into the
      // user message inside <memory-context> fences — never the system prompt. Builtin returns "".
      const recall = this.memoryManager ? await this.memoryManager.prefetchAll(modelPrompt) : "";
      this.appendMessage({
        role: "user",
        content: recall ? `CodeForge workspace context:\n\n${contextText}\n\n${recall}` : `CodeForge workspace context:\n\n${contextText}`
      });
      this.emitContextUsage();

      await this.runModelLoop(provider, model, abort);
      await this.autoCompactContextIfNeeded(provider, model, abort, "after request");
    } catch (error) {
      this.recordInspector("error", "run", "Request failed.", errorMessage(error));
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.clearRunningAbort(abort);
      this.drainQueuedWork();
    }
  }

  async approve(id: string): Promise<void> {
    const approval = this.approvals.take(id);
    if (!approval) {
      this.emit({ type: "error", text: "That approval request is no longer pending." });
      return;
    }
    const remainingInvocations = this.approvalContinuations.get(id);
    this.approvalContinuations.delete(id);
    const workerWaiter = this.workerApprovalWaiters.get(id);
    const approvalInvocation = invocationForApproval(approval);

    const validation = validateAction(approval.action);
    if (!validation.ok) {
      const message = validation.message ?? "Stored approval failed validation.";
      const text = toolError(message);
      this.emitToolUseForInvocation(approvalInvocation, "failed", false);
      await this.recordApprovalResolved(id, false, message);
      if (workerWaiter) {
        this.workerApprovalWaiters.delete(id);
        workerWaiter.resolve(text);
      } else {
        this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, text);
        this.appendCancelledToolResults(remainingInvocations, message);
      }
      this.emit({ type: "approvalResolved", id, accepted: false, text: message });
      this.emit({ type: "toolResult", text });
      this.emit({ type: "error", text: message });
      await this.publishState();
      if (!workerWaiter) {
        void this.continueAfterToolResult(approvalContinuationPrompt(approval.action, "failed"), "Continuing after failed action.");
      }
      return;
    }

    if (approval.origin === "worker" && !workerWaiter) {
      const text = "This worker approval expired because the worker is no longer running.";
      this.emitToolUseForInvocation(approvalInvocation, "failed", false);
      await this.recordApprovalResolved(id, false, text);
      this.emit({ type: "approvalResolved", id, accepted: false, text });
      this.emit({ type: "error", text });
      await this.publishState();
      return;
    }
    if (workerWaiter && !this.workers.list().some((worker) => worker.id === workerWaiter.workerId && worker.status === "running")) {
      const text = "This worker approval expired because the worker was stopped before approval.";
      this.emitToolUseForInvocation(approvalInvocation, "failed", false);
      this.workerApprovalWaiters.delete(id);
      workerWaiter.resolve(toolError(text));
      await this.recordApprovalResolved(id, false, text);
      this.emit({ type: "approvalResolved", id, accepted: false, text });
      this.emit({ type: "error", text });
      await this.publishState();
      return;
    }

    await this.recordApprovalResolved(id, true, "Accepted.");
    this.recordAudit(approval.action, approvalPermissionDecision(approval), "accepted");
    this.recordInspector("info", "approval", `Approved ${approval.action.type}.`, approval.summary);
    this.emitToolUseForInvocation(approvalInvocation, "running", false);
    try {
      const transcriptResult = await this.executePermittedAction(approval.action, approval.toolCallId);
      this.emitToolUseForInvocation(approvalInvocation, isToolErrorText(transcriptResult) ? "failed" : "completed", false);
      if (workerWaiter) {
        this.workerApprovalWaiters.delete(id);
        workerWaiter.resolve(transcriptResult);
        this.emit({
          type: "approvalResolved",
          id,
          accepted: true,
          text: approvalAcceptedText(approval.action, transcriptResult)
        });
        this.emit({ type: "toolResult", text: transcriptResult });
        this.emitContextUsage();
        await this.publishState();
        return;
      }
      // Fold the "keep going" guidance into the tool-result message rather than appending it as a
      // separate trailing user turn. This preserves the continuation nudge for the model while
      // keeping the next request ending in a `tool` message (a `tool` -> `user` adjacency stalls
      // many local OpenAI-compatible chat templates).
      const acceptedContinuation = approvalContinuationPrompt(approval.action, "accepted");
      this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, `${transcriptResult}\n\n${acceptedContinuation}`);
      this.emit({
        type: "approvalResolved",
        id,
        accepted: true,
        text: approvalAcceptedText(approval.action, transcriptResult)
      });
      this.emit({ type: "toolResult", text: transcriptResult });
      this.emitContextUsage();
      await this.publishState();
      void this.continueAfterToolResult(acceptedContinuation, "Continuing after approval.", remainingInvocations);
    } catch (error) {
      const message = errorMessage(error);
      const text = toolError(message);
      this.emitToolUseForInvocation(approvalInvocation, "failed", false);
      this.recordAudit(approval.action, approvalPermissionDecision(approval), "failed");
      this.recordInspector("error", "approval", `Approved ${approval.action.type} failed.`, message);
      if (workerWaiter) {
        this.workerApprovalWaiters.delete(id);
        workerWaiter.resolve(text);
        this.emit({ type: "approvalResolved", id, accepted: true, text: `Approved action failed: ${message}` });
        this.emit({ type: "toolResult", text });
        this.emitContextUsage();
        await this.publishState();
        return;
      }
      const failedContinuation = approvalContinuationPrompt(approval.action, "failed");
      this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, `${text}\n\n${failedContinuation}`);
      this.appendCancelledToolResults(remainingInvocations, `Previous approved ${approval.action.type} failed: ${message}`);
      this.emit({ type: "approvalResolved", id, accepted: true, text: `Approved action failed: ${message}` });
      this.emit({ type: "toolResult", text });
      this.emitContextUsage();
      await this.publishState();
      void this.continueAfterToolResult(failedContinuation, "Continuing after failed action.");
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
      const remainingInvocations = this.approvalContinuations.get(id);
      this.approvalContinuations.delete(id);
      const text = `${approval.action.type}\n\nUser rejected this tool request. Treat this as a failed approach, do not stop the task, and look for an alternative way to satisfy the user's goal within the current permissions.`;
      const workerWaiter = this.workerApprovalWaiters.get(id);
      await this.recordApprovalResolved(id, false, "Rejected.");
      this.recordAudit(approval.action, approvalPermissionDecision(approval), "rejected");
      this.recordInspector("warn", "approval", `Rejected ${approval.action.type}.`, approval.summary);
      if (approval.origin === "worker" && !workerWaiter) {
        this.emit({ type: "approvalResolved", id, accepted: false, text: "Rejected." });
        this.emit({ type: "toolResult", text });
        this.emitContextUsage();
        void this.publishState();
        return;
      }
      if (workerWaiter) {
        this.workerApprovalWaiters.delete(id);
        workerWaiter.resolve(text);
        this.emit({ type: "approvalResolved", id, accepted: false, text: "Rejected." });
        this.emit({ type: "toolResult", text });
        this.emitContextUsage();
        void this.publishState();
        return;
      }
      this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, text);
      this.appendCancelledToolResults(remainingInvocations, `User rejected ${approval.action.type}; re-plan before requesting later tool calls from the same turn.`);
      this.emit({ type: "approvalResolved", id, accepted: false, text: "Rejected." });
      this.emit({ type: "toolResult", text });
      this.emitContextUsage();
      void this.publishState();
      void this.continueAfterToolResult(approvalContinuationPrompt(approval.action, "rejected"), "Continuing after rejection.");
    }
  }

  private async runModelLoop(provider: LlmProvider, model: string, abort: AbortController): Promise<void> {
    const maxToolTurns = this.config.getAgentMode() === "agent" ? maxAgentToolTurns : maxReadOnlyToolTurns;
    const maxInvalidRetries = this.config.getMaxInvalidToolCallRetries();
    let consecutiveInvalidIterations = 0;
    for (let iteration = 0; iteration < maxToolTurns; iteration++) {
      this.compactOldToolResultsIfNeeded();
      this.emit({ type: "status", text: `Calling ${provider.profile.label} / ${model}` });
      const capabilities = await this.capabilities(provider, model, abort.signal);
      const agentMode = this.config.getAgentMode();
      const mcpToolBindings = new Map<string, McpToolBinding>();
      const requestTools = capabilities.nativeToolCalls
        ? await this.toolDefinitionsForRequest(agentMode, mcpToolBindings, abort.signal)
        : undefined;
      let assistantText = "";
      const nativeToolCalls: ToolCall[] = [];
      const invocations: ToolInvocation[] = [];
      const invalidNativeToolCalls: InvalidNativeToolCall[] = [];

      this.lastTokenUsage = undefined;
      this.emitContextUsage();
      // Always re-request the existing transcript (which ends in the tool result) rather than
      // appending a trailing user turn. A `tool` -> `user` adjacency is mis-rendered by many local
      // OpenAI-compatible chat templates, which return an empty turn and silently stall the loop.
      // This keeps the post-approval request byte-shape-identical to the (working) full-auto path.
      for await (const event of this.streamChatWithIdleTimeout(provider, {
        model,
        messages: this.messages,
        tools: requestTools,
        maxTokens: this.requestMaxTokens(),
        signal: abort.signal
      }, abort, "Model request")) {
        if (event.type === "content") {
          assistantText += event.text;
          this.emit({ type: "assistantDelta", text: event.text });
        } else if (event.type === "toolCalls") {
          for (const toolCall of event.toolCalls) {
            nativeToolCalls.push(toolCall);
            const parsed = this.parseNativeToolCall(toolCall, mcpToolBindings);
            if (parsed.ok) {
              invocations.push({
                id: toolCall.id,
                action: parsed.action,
                source: "native",
                toolCallId: toolCall.id
              });
            } else {
              invalidNativeToolCalls.push({ toolCall, message: parsed.message });
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

      for (const invalidToolCall of invalidNativeToolCalls) {
        this.appendInvalidNativeToolCallResult(invalidToolCall);
      }

      const fallbackActions = parseActionsFromAssistantText(assistantText).map((action, index): ToolInvocation => ({
        id: `json-${Date.now()}-${iteration}-${index}`,
        action,
        source: "json"
      }));
      const actions = [...invocations, ...fallbackActions];
      if (actions.length === 0) {
        if (invalidNativeToolCalls.length > 0) {
          consecutiveInvalidIterations++;
          if (consecutiveInvalidIterations > maxInvalidRetries) {
            const stopMessage = `Stopped after ${consecutiveInvalidIterations} consecutive invalid tool-call iteration${consecutiveInvalidIterations === 1 ? "" : "s"} from the model.`;
            this.recordInspector("error", "run", stopMessage, "Raise codeforge.agent.maxInvalidToolCallRetries if your model needs more retries, or check the model's tool-call format.");
            this.emit({ type: "error", text: stopMessage });
            this.emit({ type: "status", text: stopMessage });
            return;
          }
          continue;
        }
        this.emit({ type: "status", text: "Idle" });
        return;
      }
      consecutiveInvalidIterations = 0;
      this.toolIterationCount += 1;

      const shouldContinue = await this.handleActions(actions);
      if (abort.signal.aborted) {
        this.emit({ type: "status", text: "Stopped." });
        return;
      }
      if (!shouldContinue) {
        return;
      }
    }

    this.emit({ type: "status", text: `Stopped after the maximum local tool turn count (${maxToolTurns}).` });
  }

  private async handleActions(invocations: readonly ToolInvocation[]): Promise<boolean> {
    let index = 0;
    let continuedWithLocalContext = false;

    while (index < invocations.length) {
      // Re-read the permission policy and agent mode each pass so a mid-run switch to Full Auto (or a
      // stricter mode) takes effect immediately instead of staying pinned to the value captured when
      // this batch started.
      const permissionPolicy = this.config.getPermissionPolicy();
      const agentMode = this.config.getAgentMode();
      const concurrentBatch: ToolInvocation[] = [];
      while (index < invocations.length && isConcurrencySafeAction(invocations[index].action)) {
        const invocation = invocations[index];
        const validation = validateAction(invocation.action);
        if (!validation.ok) {
          this.appendDeniedOrInvalidToolResult(invocation, validation.message ?? "Tool input failed validation.");
          continuedWithLocalContext = true;
          index++;
          continue;
        }

        if (!isReadOnlyAction(invocation.action) && agentMode !== "agent") {
          const reason = `${agentModeLabel(agentMode)} mode is read-only. Use read-only repo context and switch to Agent mode before applying edits or running commands.`;
          this.recordAudit(invocation.action, { behavior: "deny", source: "default", reason }, "denied");
          this.appendDeniedOrInvalidToolResult(invocation, reason);
          continuedWithLocalContext = true;
          index++;
          continue;
        }

        const decision = evaluateActionPermission(invocation.action, permissionPolicy);
        if (decision.behavior === "deny") {
          this.recordAudit(invocation.action, decision, "denied");
          this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
          continuedWithLocalContext = true;
          index++;
          continue;
        }
        if (decision.behavior === "ask") {
          this.recordAudit(invocation.action, decision, "approval");
          if (concurrentBatch.length > 0) {
            break;
          }
          const approval = await this.requestApprovalOrReturnToolError(invocation, decision);
          if (!approval) {
            continuedWithLocalContext = true;
            index++;
            continue;
          }
          this.storeApprovalContinuation(approval.id, invocations.slice(index + 1));
          this.emitToolUseForInvocation(invocation, "approval", false);
          return false;
        }

        this.recordAudit(invocation.action, decision, "allowed");
        concurrentBatch.push(invocation);
        index++;
      }

      if (concurrentBatch.length > 0) {
        await this.executeConcurrentInvocations(concurrentBatch);
        continuedWithLocalContext = true;
        continue;
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

      if (!isReadOnlyAction(invocation.action) && agentMode !== "agent") {
        const reason = `${agentModeLabel(agentMode)} mode is read-only. Use read-only repo context and switch to Agent mode before applying edits or running commands.`;
        this.recordAudit(invocation.action, { behavior: "deny", source: "default", reason }, "denied");
        this.appendDeniedOrInvalidToolResult(invocation, reason);
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      const decision = evaluateActionPermission(invocation.action, permissionPolicy);
      if (decision.behavior === "deny") {
        this.recordAudit(invocation.action, decision, "denied");
        this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      if (decision.behavior === "ask") {
        this.recordAudit(invocation.action, decision, "approval");
        const approval = await this.requestApprovalOrReturnToolError(invocation, decision);
        if (!approval) {
          continuedWithLocalContext = true;
          index++;
          continue;
        }
        this.storeApprovalContinuation(approval.id, invocations.slice(index + 1));
        this.emitToolUseForInvocation(invocation, "approval", false);
        return false;
      }

      this.recordAudit(invocation.action, decision, "allowed");
      if (isApprovalAction(invocation.action) || invocation.action.type === "open_diff" || invocation.action.type === "memory" || invocation.action.type === "skill_manage" || isInternalAutomationAction(invocation.action) || isInternalStateAction(invocation.action) || isInternalReadAction(invocation.action)) {
        await this.executePermittedInvocation(invocation);
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

  private appendInvalidNativeToolCallResult(invalid: InvalidNativeToolCall): void {
    const text = toolError(invalid.message);
    this.appendToolResult(invalid.toolCall.id, invalid.toolCall.name || "tool", text);
    this.emit({
      type: "toolUse",
      toolUse: {
        id: invalid.toolCall.id,
        name: invalid.toolCall.name || "tool",
        summary: `Invalid tool call: ${invalid.toolCall.name || "unknown"}`,
        status: "failed",
        readOnly: false
      }
    });
    this.emit({ type: "toolResult", text });
    this.emitContextUsage();
  }

  private async executeConcurrentInvocations(invocations: readonly ToolInvocation[]): Promise<void> {
    const results = await Promise.all(invocations.map(async (invocation) => {
      this.emitToolUseForInvocation(invocation, "running", isReadOnlyAction(invocation.action));
      const text = await this.executeActionWithFailureHooks(invocation.action, invocation.toolCallId);
      return { invocation, text };
    }));

    for (const result of results) {
      this.appendToolResult(result.invocation.toolCallId, result.invocation.action.type, result.text);
      this.emit({ type: "toolResult", text: result.text });
      this.emitToolUseForInvocation(result.invocation, isToolErrorText(result.text) ? "failed" : "completed", isReadOnlyAction(result.invocation.action));
      this.emitContextUsage();
    }
  }

  private async executePermittedInvocation(invocation: ToolInvocation): Promise<void> {
    this.emitToolUseForInvocation(invocation, "running", isReadOnlyAction(invocation.action));
    const text = await this.executeActionWithFailureHooks(invocation.action, invocation.toolCallId);
    this.appendToolResult(invocation.toolCallId, invocation.action.type, text);
    this.emit({ type: "toolResult", text });
    this.emitToolUseForInvocation(invocation, isToolErrorText(text) ? "failed" : "completed", isReadOnlyAction(invocation.action));
  }

  private async executeActionWithFailureHooks(action: AgentAction, toolCallId: string | undefined): Promise<string> {
    this.recordInspector("info", "tool", `Running ${action.type}.`, toolSummary(action));
    try {
      const result = await this.executePermittedAction(action, toolCallId);
      this.recordInspector(isToolErrorText(result) ? "warn" : "info", "tool", `Finished ${action.type}.`, firstLines(result, 8));
      return result;
    } catch (error) {
      const content = toolError(errorMessage(error));
      this.recordInspector("error", "tool", `${action.type} failed.`, errorMessage(error));
      try {
        await this.runLocalHooks("postToolFailure", action);
        return content;
      } catch (hookError) {
        return `${content}\n${toolError(`postToolFailure hook failed: ${errorMessage(hookError)}`)}`;
      }
    }
  }

  private async requestApproval(action: AgentAction, toolCallId: string | undefined, decision: PermissionDecision, metadata?: { readonly detail?: string; readonly risk?: string; readonly origin?: ApprovalRequest["origin"] }): Promise<ApprovalRequest> {
    let approvalMetadata = metadata ?? this.approvalMetadata(action, decision);
    try {
      await this.preflightWritableAction(action);
      if (action.type === "propose_patch") {
        await this.diff.previewPatch(action.patch);
      } else if (action.type === "write_file") {
        await this.diff.previewWriteFile(action);
      } else if (action.type === "edit_file") {
        await this.diff.previewEditFile(action);
      }
    } catch (error) {
      if (isRecoverableEditPreflightError(error)) {
        throw error;
      }
      const previewError = `Diff preview unavailable: ${errorMessage(error)}`;
      this.recordInspector("warn", "approval", `Preview failed for ${action.type}.`, previewError);
      approvalMetadata = {
        ...approvalMetadata,
        detail: [approvalMetadata.detail, previewError].filter((item): item is string => Boolean(item)).join("\n\n")
      };
    }
    const approval = this.approvals.createForAction(action, decision, toolCallId, approvalMetadata);
    await this.recordApprovalRequested(approval);
    this.recordInspector("warn", "approval", `Approval requested for ${action.type}.`, decision.reason);
    this.emit({ type: "approvalRequested", approval });
    return approval;
  }

  private async requestApprovalOrReturnToolError(invocation: ToolInvocation, decision: PermissionDecision): Promise<ApprovalRequest | undefined> {
    try {
      return await this.requestApproval(invocation.action, invocation.toolCallId, decision);
    } catch (error) {
      if (!isRecoverableEditPreflightError(error)) {
        throw error;
      }
      const message = errorMessage(error);
      this.recordAudit(invocation.action, decision, "failed");
      this.recordInspector("warn", "approval", `${invocation.action.type} failed preflight.`, firstLines(message, 12));
      this.appendDeniedOrInvalidToolResult(invocation, message);
      return undefined;
    }
  }

  private async preflightWritableAction(action: AgentAction): Promise<void> {
    if (action.type === "notebook_edit_cell") {
      const current = await this.readWorkspaceFileIfExists(action.path, 1);
      if (current.exists && !this.notebookReadState.has(readStateKey(action.path))) {
        throw modelRecoverableToolError([
          `notebook_edit_cell requires reading ${action.path} before modifying an existing notebook.`,
          "Call notebook_read for the exact repo-relative path, inspect the current cells, then retry the notebook edit.",
          "Do not ask the user to approve this unchanged."
        ].join("\n"));
      }
      return;
    }

    if (action.type !== "write_file" && action.type !== "edit_file") {
      return;
    }

    const current = await this.readWorkspaceFileIfExists(action.path, 1);
    if (!current.exists) {
      return;
    }

    const key = readStateKey(action.path);
    const snapshot = this.readFileState.get(key);
    if (!snapshot) {
      throw modelRecoverableToolError([
        `${action.type} requires reading ${action.path} before modifying an existing file.`,
        "Call read_file for the exact repo-relative path, inspect the current contents, then retry the edit or write.",
        "Do not ask the user to approve this unchanged."
      ].join("\n"));
    }

    const latest = await this.readWorkspaceFileIfExists(action.path, snapshot.maxBytes);
    if (!latest.exists || latest.content !== snapshot.content) {
      this.readFileState.delete(key);
      throw modelRecoverableToolError([
        `${action.type} cannot modify ${action.path} because the file changed since it was read.`,
        "Call read_file again, inspect the current contents, then retry with a fresh edit or full-file write.",
        "Do not repeat the same stale tool call unchanged."
      ].join("\n"));
    }
  }

  private async readWorkspaceFileIfExists(path: string, maxBytes: number): Promise<{ readonly exists: boolean; readonly content: string }> {
    try {
      return {
        exists: true,
        content: await this.workspace.readTextFile(path, maxBytes, this.runningAbort?.signal)
      };
    } catch (error) {
      const message = errorMessage(error);
      if (isMissingFileError(message)) {
        return { exists: false, content: "" };
      }
      throw error;
    }
  }

  private rememberReadFile(path: string, content: string, maxBytes: number, source: ReadFileSnapshot["source"]): void {
    this.readFileState.set(readStateKey(path), {
      content,
      maxBytes,
      readAt: Date.now(),
      source
    });
  }

  private async rememberCurrentFile(path: string): Promise<void> {
    const current = await this.readWorkspaceFileIfExists(path, 48000);
    if (current.exists) {
      this.rememberReadFile(path, current.content, 48000, "tool");
    }
  }

  private approvalMetadata(action: AgentAction, decision: PermissionDecision): { readonly detail?: string; readonly risk?: string } {
    if (action.type === "mcp_call_tool") {
      const server = this.config.getMcpServers().find((item) => item.id === action.serverId);
      return {
        risk: "configured MCP service tool",
        detail: [
          `Server: ${action.serverId}${server ? ` (${server.label})` : ""}`,
          `Transport: ${server?.transport ?? "unknown"}`,
          `Tool: ${action.toolName}`,
          `Permission: ${decision.reason}`
        ].join("\n")
      };
    }

    if (action.type === "ask_user_question") {
      return {
        risk: "requires user input",
        detail: action.questions.map((question, index) => {
          const options = question.options.map((option) => `  - ${option.label}: ${option.description}`).join("\n");
          return `${index + 1}. ${question.question}\n${options}`;
        }).join("\n\n")
      };
    }

    if (action.type === "notebook_edit_cell") {
      return {
        risk: "workspace notebook edit",
        detail: [
          `Path: ${action.path}`,
          `Cell: ${action.index}`,
          action.kind ? `Kind: ${action.kind}` : undefined,
          action.language ? `Language: ${action.language}` : undefined,
          "",
          action.content
        ].filter((line): line is string => line !== undefined).join("\n")
      };
    }

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

  private storeApprovalContinuation(approvalId: string, remainingInvocations: readonly ToolInvocation[]): void {
    if (remainingInvocations.length > 0) {
      this.approvalContinuations.set(approvalId, remainingInvocations);
    }
  }

  private appendCancelledToolResults(invocations: readonly ToolInvocation[] | undefined, reason: string): void {
    if (!invocations || invocations.length === 0) {
      return;
    }
    for (const invocation of invocations) {
      const text = toolError(`Cancelled pending ${invocation.action.type}: ${reason}`);
      this.emitToolUseForInvocation(invocation, "failed", isLocalReadOnlyAction(invocation.action));
      this.appendToolResult(invocation.toolCallId, invocation.action.type, text);
      this.emit({ type: "toolResult", text });
    }
    this.emitContextUsage();
  }

  private async continuePendingToolCalls(invocations: readonly ToolInvocation[] | undefined): Promise<boolean> {
    if (!invocations || invocations.length === 0) {
      return true;
    }
    this.emit({ type: "status", text: `Continuing ${invocations.length} queued tool call(s) from the approved turn.` });
    return this.handleActions(invocations);
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

  private async executeWorkerAction(action: AgentAction, toolCallId: string | undefined, worker: WorkerSummary): Promise<string> {
    const validation = validateAction(action);
    if (!validation.ok) {
      return toolError(validation.message ?? "Tool input failed validation.");
    }

    if (!isReadOnlyAction(action) && this.config.getAgentMode() !== "agent") {
      return toolError(`${agentModeLabel(this.config.getAgentMode())} mode is read-only. Switch to Agent mode before allowing workers to edit files, run commands, or call local services.`);
    }

    const decision = evaluateActionPermission(action, this.config.getPermissionPolicy());
    if (decision.behavior === "deny") {
      this.recordAudit(action, decision, "denied");
      return toolError(`${action.type} was denied by the parent permission policy. ${decision.reason}`);
    }

    if (decision.behavior === "ask") {
      this.recordAudit(action, decision, "approval");
      let approval: ApprovalRequest;
      try {
        approval = await this.requestApproval(action, toolCallId, decision, this.workerApprovalMetadata(worker, action, decision));
      } catch (error) {
        if (!isRecoverableEditPreflightError(error)) {
          throw error;
        }
        this.recordAudit(action, decision, "failed");
        return toolError(errorMessage(error));
      }
      this.emit({
        type: "toolUse",
        toolUse: {
          id: toolCallId ?? `${worker.id}-${approval.id}`,
          name: action.type,
          summary: `${worker.label} worker requested ${toolSummary(action)}`,
          status: "approval",
          readOnly: false
        }
      });
      return new Promise((resolve) => {
        this.workerApprovalWaiters.set(approval.id, { workerId: worker.id, resolve });
      });
    }

    this.recordAudit(action, decision, "allowed");
    return this.executePermittedAction(action, toolCallId);
  }

  private async workerSkillsDigest(prompt: string): Promise<string | undefined> {
    const settings = this.config.getMemorySettings();
    if (!settings.skillsEnabled) {
      return undefined;
    }
    const skills = await loadLocalSkills(this.workspace).catch(() => []);
    return formatSkillsDigest(skills, prompt, settings.skillsDigestBytes) || undefined;
  }

  private workerApprovalMetadata(worker: WorkerSummary, action: AgentAction, decision: PermissionDecision): { readonly detail?: string; readonly risk?: string; readonly origin: "worker" } {
    const base = this.approvalMetadata(action, decision);
    return {
      origin: "worker",
      risk: base.risk,
      detail: [
        `Requested by worker: ${worker.label} (${worker.id})`,
        `Worker task: ${worker.prompt}`,
        base.detail
      ].filter((line): line is string => Boolean(line)).join("\n")
    };
  }

  async answerQuestion(id: string, answers: Readonly<Record<string, string>>): Promise<void> {
    const approval = this.approvals.take(id);
    if (!approval) {
      this.emit({ type: "error", text: "That question is no longer pending." });
      return;
    }
    if (approval.action.type !== "ask_user_question") {
      this.emit({ type: "error", text: "That approval request is not a user question." });
      return;
    }

    const validation = validateAction(approval.action);
    if (!validation.ok) {
      await this.recordApprovalResolved(id, false, validation.message ?? "Stored question failed validation.");
      this.emit({ type: "approvalResolved", id, accepted: false, text: validation.message ?? "Stored question failed validation." });
      return;
    }

    const missing = approval.action.questions.find((question) => !answers[question.question]?.trim());
    if (missing) {
      this.approvals.restore([...this.approvals.list(), approval]);
      this.emit({ type: "error", text: `Answer required: ${missing.question}` });
      this.emit({ type: "approvalRequested", approval });
      return;
    }

    const remainingInvocations = this.approvalContinuations.get(id);
    this.approvalContinuations.delete(id);
    const text = formatQuestionAnswers(approval.action.questions, answers);
    const workerWaiter = this.workerApprovalWaiters.get(id);
    await this.recordApprovalResolved(id, true, "Answered.");
    if (workerWaiter) {
      this.workerApprovalWaiters.delete(id);
      workerWaiter.resolve(text);
      this.emit({ type: "approvalResolved", id, accepted: true, text: "Answered." });
      this.emit({ type: "toolResult", text });
      this.emitContextUsage();
      await this.publishState();
      return;
    }

    this.appendToolResult(approval.toolCallId, approval.toolName ?? approval.action.type, text);
    this.emit({ type: "approvalResolved", id, accepted: true, text: "Answered." });
    this.emit({ type: "toolResult", text });
    this.emitContextUsage();
    await this.publishState();
    void this.continueAfterToolResult(undefined, "Continuing after user answer.", remainingInvocations);
  }

  private formatToolList(): string {
    const lines = codeForgeTools.map((tool) => {
      const loading = (this.config.getAgentMode() === "agent" ? coreAgentToolNames : coreReadOnlyToolNames).has(tool.name)
        ? "core"
        : "deferred";
      const approval = tool.requiresApproval ? "approval" : "auto";
      const concurrent = tool.concurrencySafe ? "concurrent" : "serial";
      return `- ${tool.name} | ${loading} | risk=${tool.risk} | ${approval} | ${concurrent} | ${tool.description}`;
    });
    return `tool_list\n\n${lines.join("\n")}\n\nUse tool_search with a capability query or select:tool_name to load deferred schemas.`;
  }

  private async searchToolSchemas(action: Extract<AgentAction, { readonly type: "tool_search" }>): Promise<string> {
    const mode = this.config.getAgentMode();
    const allowedToolNames = new Set(toolDefinitionsForAgentMode(mode).map((tool) => tool.name));
    const limit = Math.max(1, Math.min(action.limit ?? 8, 20));
    const codeForgeMatches = searchCodeForgeTools(action.query, allowedToolNames);
    const mcpMatches = mode === "agent"
      ? await this.searchMcpToolSchemas(action.query, limit)
      : [];
    const combined = [...codeForgeMatches, ...mcpMatches]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);

    if (combined.length === 0) {
      return [
        `tool_search ${action.query}`,
        "",
        "No matching tools found.",
        "Try broader terms such as code symbols, task tracking, notebook, memory, mcp, command, edit, or select:tool_name."
      ].join("\n");
    }

    return [
      `tool_search ${action.query}`,
      "",
      "The following schemas are now loaded for the next model turn:",
      "",
      ...combined.map((match) => match.content)
    ].join("\n");
  }

  private async searchMcpToolSchemas(query: string, limit: number): Promise<readonly ToolSchemaSearchResult[]> {
    if (this.config.getMcpServers().length === 0) {
      return [];
    }

    try {
      const inspections = await inspectConfiguredMcpServers(
        this.config.getMcpServers(),
        this.config.getNetworkPolicy(),
        undefined,
        this.runningAbort?.signal
      );
      const selected = selectedToolNames(query);
      const usedNames = new Set(toolDefinitions.map((tool) => tool.name));
      const results: ToolSchemaSearchResult[] = [];
      for (const inspection of inspections) {
        if (inspection.error || !inspection.status.valid || !inspection.status.enabled) {
          continue;
        }
        for (const tool of inspection.tools) {
          const functionName = mcpFunctionName(inspection.status.id, tool.name, usedNames);
          usedNames.add(functionName);
          const score = scoreToolSearch(query, selected, functionName, tool.description, ["mcp", inspection.status.id, tool.name]);
          if (score <= 0) {
            continue;
          }
          results.push({
            name: functionName,
            score,
            content: formatMcpToolSchemaSearchResult(functionName, inspection.status.id, tool)
          });
        }
      }
      return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(limit, 8));
    } catch {
      return [];
    }
  }

  private async createTask(action: Extract<AgentAction, { readonly type: "task_create" }>): Promise<string> {
    const now = Date.now();
    const task: CodeForgeTask = {
      id: `task-${now}-${Math.random().toString(16).slice(2)}`,
      subject: action.subject.trim(),
      description: action.description?.trim() || undefined,
      activeForm: action.activeForm?.trim() || undefined,
      status: "pending",
      owner: action.owner?.trim() || undefined,
      blocks: uniqueStrings(action.blocks),
      blockedBy: uniqueStrings(action.blockedBy),
      metadata: action.metadata,
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(task.id, task);
    await this.recordTask(task, "created");
    await this.publishState();
    return `task_create ${task.id}\n\n${formatTask(task)}`;
  }

  private async updateTask(action: Extract<AgentAction, { readonly type: "task_update" }>): Promise<string> {
    const existing = this.tasks.get(action.taskId);
    if (!existing) {
      return toolError(`No task found for ${action.taskId}.`);
    }
    const now = Date.now();
    const nextStatus = action.status ?? existing.status;
    const task: CodeForgeTask = {
      ...existing,
      subject: action.subject?.trim() || existing.subject,
      description: action.description !== undefined ? action.description.trim() || undefined : existing.description,
      activeForm: action.activeForm !== undefined ? action.activeForm.trim() || undefined : existing.activeForm,
      status: nextStatus,
      owner: action.owner !== undefined ? action.owner.trim() || undefined : existing.owner,
      blocks: action.blocks !== undefined ? uniqueStrings(action.blocks) : existing.blocks,
      blockedBy: action.blockedBy !== undefined ? uniqueStrings(action.blockedBy) : existing.blockedBy,
      metadata: action.metadata !== undefined ? { ...(existing.metadata ?? {}), ...action.metadata } : existing.metadata,
      updatedAt: now,
      completedAt: nextStatus === "completed" ? existing.completedAt ?? now : nextStatus === "cancelled" ? existing.completedAt ?? now : existing.completedAt
    };
    this.tasks.set(task.id, task);
    await this.recordTask(task, "updated");
    await this.publishState();
    return `task_update ${task.id}\n\n${formatTask(task)}`;
  }

  private listTasks(action: Extract<AgentAction, { readonly type: "task_list" }>): string {
    const tasks = [...this.tasks.values()]
      .filter((task) => !action.status || task.status === action.status)
      .filter((task) => !action.owner || task.owner === action.owner)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (tasks.length === 0) {
      return "task_list\n\nNo tasks.";
    }
    return `task_list\n\n${tasks.map(formatTaskLine).join("\n")}`;
  }

  private getTask(taskId: string): string {
    const task = this.tasks.get(taskId);
    return task ? `task_get ${task.id}\n\n${formatTask(task)}` : toolError(`No task found for ${taskId}.`);
  }

  private async listMcpResourcesForTool(serverId: string | undefined): Promise<string> {
    const inspections = await inspectConfiguredMcpServers(
      this.config.getMcpServers(),
      this.config.getNetworkPolicy(),
      serverId,
      this.runningAbort?.signal
    );
    return `mcp_list_resources${serverId ? ` ${serverId}` : ""}\n\n${formatMcpInspectionReport(inspections, "resources")}`;
  }

  private async recordTask(task: CodeForgeTask, event: "created" | "updated"): Promise<void> {
    await this.appendSessionRecord((sessionId) => ({
      type: "task",
      sessionId,
      createdAt: Date.now(),
      event,
      task
    }));
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
      if (!result.isError && action.type === "read_file") {
        this.rememberReadFile(action.path, readFileContentFromToolResult(transcriptResult, action.path), 48000, "tool");
      }
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "spawn_agent") {
      transcriptResult = await this.executeSpawnAgentAction(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "worker_output") {
      if (action.wait) {
        await this.workers.waitFor(action.workerId, workerJoinTimeoutMs, this.runningAbort?.signal);
      }
      transcriptResult = this.workers.output(action.workerId) ?? `worker_output ${action.workerId}\n\nNo worker found.`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "ask_user_question") {
      transcriptResult = toolError("ask_user_question requires a user answer and cannot be auto-approved.");
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "tool_list") {
      transcriptResult = this.formatToolList();
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "tool_search") {
      transcriptResult = await this.searchToolSchemas(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_create") {
      transcriptResult = await this.createTask(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_update") {
      transcriptResult = await this.updateTask(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_list") {
      transcriptResult = this.listTasks(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_get") {
      transcriptResult = this.getTask(action.taskId);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "code_hover" || action.type === "code_definition" || action.type === "code_references" || action.type === "code_symbols") {
      transcriptResult = await this.codeIntel.execute(action, this.runningAbort?.signal);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "notebook_read") {
      transcriptResult = await this.notebooks.execute(action, this.runningAbort?.signal);
      this.notebookReadState.add(readStateKey(action.path));
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "mcp_list_resources") {
      transcriptResult = await this.listMcpResourcesForTool(action.serverId);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "mcp_read_resource") {
      const resource = await readConfiguredMcpResource(
        this.config.getMcpServers(),
        this.config.getNetworkPolicy(),
        action.serverId,
        action.uri,
        this.runningAbort?.signal
      );
      transcriptResult = `mcp_read_resource ${resource.serverId}:${resource.uri}\n\n${resource.content}`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "memory") {
      if (!this.memoryManager) {
        throw new Error("Local memory is not available in this environment.");
      }
      await this.ensureMemoryInitialized();
      transcriptResult = await this.memoryManager.handleToolCall("memory", {
        action: action.action,
        target: action.target,
        content: action.content,
        old_text: action.oldText
      });
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "skill_manage") {
      if (!this.skillManager) {
        throw new Error("Local skills are not available in this environment.");
      }
      transcriptResult = await this.skillManager.handleManage(
        {
          action: action.action,
          name: action.name,
          content: action.content,
          old_string: action.oldString,
          new_string: action.newString,
          replace_all: action.replaceAll,
          file_path: action.filePath,
          file_content: action.fileContent,
          absorbed_into: action.absorbedInto
        },
        { markAgentCreated: this.inBackgroundReview }
      );
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "skill_view") {
      if (!this.skillManager) {
        throw new Error("Local skills are not available in this environment.");
      }
      return this.skillManager.handleView({ name: action.name, file_path: action.filePath });
    }

    if (action.type === "skills_list") {
      if (!this.skillManager) {
        throw new Error("Local skills are not available in this environment.");
      }
      return this.skillManager.handleList();
    }

    if (action.type === "fact_store" || action.type === "fact_feedback") {
      if (!this.memoryManager) {
        throw new Error("Local memory is not available in this environment.");
      }
      await this.ensureMemoryInitialized();
      const args = action.type === "fact_store"
        ? { action: action.action, content: action.content, category: action.category, tags: action.tags, query: action.query, entity: action.entity, entities: action.entities, id: action.id, limit: action.limit }
        : { id: action.id, helpful: action.helpful };
      transcriptResult = await this.memoryManager.handleToolCall(action.type, args);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "propose_patch") {
      await this.recordCheckpoint(action, "Before applying proposed patch.");
      const changed = await this.diff.applyPatch(action.patch);
      transcriptResult = `propose_patch\n\nApplied changes to ${changed.join(", ")}.${await this.verifyChangedFiles(changed)}`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "write_file") {
      await this.preflightWritableAction(action);
      await this.recordCheckpoint(action, `Before writing ${action.path}.`);
      const changed = await this.diff.applyWriteFile(action);
      transcriptResult = `write_file ${action.path}\n\nWrote ${changed.join(", ")}.${await this.verifyChangedFiles(changed)}`;
      this.rememberReadFile(action.path, action.content, Math.max(48000, Buffer.byteLength(action.content, "utf8")), "tool");
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "edit_file") {
      await this.preflightWritableAction(action);
      await this.recordCheckpoint(action, `Before editing ${action.path}.`);
      const changed = await this.diff.applyEditFile(action);
      transcriptResult = `edit_file ${action.path}\n\nEdited ${changed.join(", ")}.${await this.verifyChangedFiles(changed)}`;
      await this.rememberCurrentFile(action.path);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "open_diff") {
      await this.diff.previewPatch(action.patch);
      transcriptResult = "open_diff\n\nOpened VS Code diff preview.";
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "mcp_call_tool") {
      transcriptResult = await callConfiguredMcpTool(
        this.config.getMcpServers(),
        this.config.getNetworkPolicy(),
        action,
        this.runningAbort?.signal
      );
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "notebook_edit_cell") {
      await this.preflightWritableAction(action);
      await this.recordCheckpoint(action, `Before editing notebook ${action.path} cell ${action.index}.`);
      transcriptResult = await this.notebooks.execute(action, this.runningAbort?.signal);
      transcriptResult = `${transcriptResult}${await this.verifyChangedFiles([action.path])}`;
      this.notebookReadState.add(readStateKey(action.path));
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

  private async verifyChangedFiles(paths: readonly string[]): Promise<string> {
    const uniquePaths = uniqueStrings(paths).filter((path) => path && path !== "/dev/null");
    if (uniquePaths.length === 0) {
      return "";
    }

    const diagnostics: WorkspaceDiagnostic[] = [];
    for (const path of uniquePaths.slice(0, 12)) {
      try {
        diagnostics.push(...await this.workspace.getDiagnostics(path, 20, this.runningAbort?.signal));
      } catch {
        // Diagnostics are best-effort after edits; failed reads should not mask a successful write.
      }
    }

    const relevant = diagnostics
      .filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning")
      .slice(0, 30);
    const detail = relevant.length > 0
      ? relevant.map((diagnostic) => `${diagnostic.severity} ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.message}`).join("\n")
      : `No VS Code errors or warnings reported for ${uniquePaths.join(", ")}.`;
    this.recordInspector(relevant.length > 0 ? "warn" : "info", "verification", `Checked diagnostics for ${uniquePaths.length} changed file(s).`, detail);
    return [
      "",
      "",
      "Verification:",
      relevant.length > 0
        ? relevant.map((diagnostic) => `- ${diagnostic.severity} ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.message}`).join("\n")
        : `- No VS Code errors or warnings reported for ${uniquePaths.join(", ")}.`
    ].join("\n");
  }

  private async runLocalHooks(event: LocalHook["event"], action: AgentAction): Promise<void> {
    const hooks = (await loadLocalHooks(this.workspace, this.runningAbort?.signal))
      .filter((hook) => localHookMatches(hook, event, action));
    for (const hook of hooks) {
      await this.runLocalHook(hook, event, action);
    }
  }

  private async runLocalHook(hook: LocalHook, event: LocalHook["event"], action: AgentAction): Promise<void> {
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

  private async continueAfterToolResult(continuationPrompt?: string, statusText = "Continuing after tool result.", remainingInvocations?: readonly ToolInvocation[]): Promise<void> {
    if (this.runningAbort) {
      this.pendingContinuation = { prompt: continuationPrompt, statusText, remainingInvocations };
      this.continueAfterCurrentRun = true;
      return;
    }

    this.continueAfterCurrentRun = false;
    this.pendingContinuation = undefined;
    const abort = new AbortController();
    this.runningAbort = abort;
    try {
      const provider = await this.createProvider();
      const model = await this.resolveModel(provider, abort.signal);
      if (continuationPrompt) {
        this.emit({ type: "status", text: statusText });
      }
      const completedPendingTools = await this.continuePendingToolCalls(remainingInvocations);
      if (!completedPendingTools || abort.signal.aborted) {
        return;
      }
      await this.runModelLoop(provider, model, abort);
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.clearRunningAbort(abort);
      this.drainQueuedWork();
    }
  }

  private clearRunningAbort(abort: AbortController): void {
    if (this.runningAbort === abort) {
      this.runningAbort = undefined;
    }
  }

  private queueCompact(focus: string): void {
    this.queueWork({ type: "compact", focus });
    this.emit({ type: "status", text: "Queued context compaction until the current CodeForge operation finishes." });
  }

  private queuePrompt(visiblePrompt: string, modelPrompt: string): void {
    this.queueWork({ type: "prompt", visiblePrompt, modelPrompt });
    this.emit({ type: "status", text: "Queued prompt until the current CodeForge operation finishes." });
  }

  private queueWork(work: QueuedWork): void {
    if (this.queuedWork.length >= queuedWorkLimit) {
      this.queuedWork.shift();
    }
    this.queuedWork.push(work);
  }

  private drainQueuedWork(): void {
    if (this.runningAbort) {
      return;
    }
    if (this.continueAfterCurrentRun) {
      const continuation = this.pendingContinuation;
      this.continueAfterCurrentRun = false;
      this.pendingContinuation = undefined;
      void this.continueAfterToolResult(continuation?.prompt, continuation?.statusText, continuation?.remainingInvocations);
      return;
    }
    const nextWork = this.queuedWork.shift();
    if (!nextWork) {
      this.emitRunCompleteIfIdle();
      return;
    }
    if (nextWork.type === "compact") {
      void this.compactContext(nextWork.focus);
    } else {
      void this.runPrompt(nextWork.visiblePrompt, nextWork.modelPrompt, false);
    }
  }

  private emitRunCompleteIfIdle(): void {
    if (this.runningAbort || this.continueAfterCurrentRun || this.queuedWork.length > 0) {
      return;
    }
    const reason = this.approvals.list().length > 0 ? "awaitingApproval" : "idle";
    this.emit({ type: "runComplete", reason });
    if (reason === "idle") {
      void this.maybeRunBackgroundReview();
      void this.maybeRunCuratorAuto();
    }
  }

  // After a turn goes idle, run a non-blocking self-improvement review: memory roughly every
  // nudgeInterval user turns, skills roughly every skillNudgeInterval tool iterations. The review is
  // a restricted tool loop (memory + skill tools only) seeded with the recent transcript. Fully
  // guarded and fire-and-forget so it can never break a user run.
  private async maybeRunBackgroundReview(): Promise<void> {
    if (this.reviewInFlight || !this.memoryManager) {
      return;
    }
    const settings = this.config.getMemorySettings();
    if (!settings.enabled || this.userTurnCount < Math.max(1, settings.reviewMinTurns)) {
      return;
    }
    const memoryDue = settings.nudgeInterval > 0 && this.userTurnCount - this.lastMemoryReviewTurnCount >= settings.nudgeInterval;
    const skillsDue = Boolean(this.skillManager) && settings.skillsEnabled && settings.skillNudgeInterval > 0
      && this.toolIterationCount - this.lastSkillReviewIterationCount >= settings.skillNudgeInterval;
    if (!memoryDue && !skillsDue) {
      return;
    }
    // Advance the markers up front so a transient failure does not immediately re-fire the review.
    if (memoryDue) {
      this.lastMemoryReviewTurnCount = this.userTurnCount;
    }
    if (skillsDue) {
      this.lastSkillReviewIterationCount = this.toolIterationCount;
    }

    const slice = this.messages.slice(this.lastReviewedMessageCount);
    const didWork = slice.some((message) => message.role === "assistant" && ((message.toolCalls?.length ?? 0) > 0 || message.content.trim().length > 0));
    if (!didWork) {
      this.lastReviewedMessageCount = this.messages.length;
      return;
    }

    this.reviewInFlight = true;
    this.inBackgroundReview = true;
    try {
      await this.ensureMemoryInitialized();
      const summary = await this.runBackgroundReview(memoryDue, skillsDue, slice);
      this.lastReviewedMessageCount = this.messages.length;
      if (summary) {
        // Per-update "learning" notices are emitted live inside runBackgroundReview as each memory,
        // user-profile, or skill write lands; here we just refresh the side panels (Learned/memory
        // list/skills) so they reflect what was just saved.
        await this.publishState();
      }
    } catch (error) {
      this.recordInspector("warn", "memory", "Background self-improvement review failed.", errorMessage(error));
    } finally {
      this.inBackgroundReview = false;
      this.reviewInFlight = false;
    }
  }

  private async runBackgroundReview(reviewMemory: boolean, reviewSkills: boolean, slice: readonly ChatMessage[]): Promise<string> {
    const transcript = slice
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n")
      .slice(-12000);
    const messages: ChatMessage[] = [
      { role: "system", content: `${buildReviewPrompt(reviewMemory, reviewSkills)}\n\n${REVIEW_TOOL_HINT}` },
      {
        role: "user",
        content: `--- Conversation to review ---\n${transcript}\n\n--- End conversation ---\n\nReview now using only the memory and skill tools. If nothing is worth saving, reply 'Nothing to save.' and stop.`
      }
    ];
    const abort = new AbortController();
    const provider = await this.createProvider();
    const model = await this.resolveModel(provider, abort.signal);
    // Only offer native tool schemas when the endpoint supports them; otherwise rely on the JSON
    // action-protocol fallback taught by REVIEW_TOOL_HINT.
    const capabilities = await this.capabilities(provider, model, abort.signal);
    const tools = capabilities.nativeToolCalls ? this.reviewToolSchemas() : undefined;
    const actions: string[] = [];

    for (let iteration = 0; iteration < maxBackgroundReviewIterations; iteration++) {
      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const event of this.streamChatWithIdleTimeout(provider, {
        model,
        messages,
        tools,
        temperature: 0,
        maxTokens: this.requestMaxTokens(),
        signal: abort.signal
      }, abort, "Self-improvement review")) {
        if (event.type === "content") {
          content += event.text;
        } else if (event.type === "toolCalls") {
          toolCalls.push(...event.toolCalls);
        }
      }

      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content, toolCalls });
        for (const toolCall of toolCalls) {
          const result = await this.executeReviewTool(toolCall.name, safeParseArgs(toolCall.argumentsJson));
          if (result.summary) {
            actions.push(result.summary);
          }
          if (result.notice) {
            this.emit({ type: "message", role: "system", text: result.notice });
          }
          messages.push({ role: "tool", content: result.output, toolCallId: toolCall.id, name: toolCall.name });
        }
        continue;
      }

      // Non-native models emit the CodeForge JSON action protocol in text instead of native calls.
      const fallback = reviewActionsFromText(content);
      for (const action of fallback) {
        const result = await this.executeReviewTool(action.name, action.args);
        if (result.summary) {
          actions.push(result.summary);
        }
        if (result.notice) {
          this.emit({ type: "message", role: "system", text: result.notice });
        }
      }
      break;
    }

    return summarizeReviewActions(actions);
  }

  private reviewToolSchemas(): ToolDefinition[] {
    const memorySchemas = this.memoryManager?.getAllToolSchemas() ?? [];
    const skillNames = new Set(["skills_list", "skill_view", "skill_manage"]);
    const skillSchemas = this.skillManager
      ? codeForgeTools.filter((tool) => skillNames.has(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    return [...memorySchemas, ...skillSchemas];
  }

  private async executeReviewTool(name: string, args: Record<string, unknown>): Promise<ReviewToolOutcome> {
    try {
      if (name === "memory" && this.memoryManager) {
        const output = await this.memoryManager.handleToolCall("memory", args);
        const ok = reviewWriteSucceeded(output);
        return { output, summary: ok ? describeMemoryWrite(args) : "", notice: ok ? learningNotice("memory", args) : "" };
      }
      if (name === "skill_manage" && this.skillManager) {
        const output = await this.skillManager.handleManage(args, { markAgentCreated: true });
        const ok = reviewWriteSucceeded(output);
        return {
          output,
          summary: ok ? `${String(args.action ?? "update")} skill ${String(args.name ?? "")}`.trim() : "",
          notice: ok ? learningNotice("skill_manage", args) : ""
        };
      }
      if (name === "skill_view" && this.skillManager) {
        return { output: await this.skillManager.handleView(args), summary: "", notice: "" };
      }
      if (name === "skills_list" && this.skillManager) {
        return { output: await this.skillManager.handleList(), summary: "", notice: "" };
      }
    } catch (error) {
      return { output: JSON.stringify({ success: false, error: errorMessage(error) }), summary: "", notice: "" };
    }
    return { output: JSON.stringify({ success: false, error: `Tool '${name}' is not available in the review pass.` }), summary: "", notice: "" };
  }

  // -- Curator (long-horizon skill maintenance) -----------------------------

  private async maybeRunCuratorAuto(): Promise<void> {
    if (this.curatorInFlight || !this.skillIo || !this.skillUsage || !this.skillManager) {
      return;
    }
    const io = this.skillIo;
    const settings = this.config.getCuratorSettings();
    const now = Date.now();
    let state;
    try {
      state = await readCuratorState(io);
    } catch {
      return;
    }
    const gate = shouldRunCurator(state, now, settings);
    if (gate.seedFirstRun) {
      state.lastRunAt = now;
      await writeCuratorState(io, state).catch(() => undefined);
      return;
    }
    if (!gate.run) {
      return;
    }
    await this.runCurator({ dryRun: false });
  }

  async runCurator(options: { readonly dryRun?: boolean } = {}): Promise<string> {
    if (!this.skillIo || !this.skillUsage || !this.skillManager) {
      return "Skills are not available in this environment.";
    }
    if (this.curatorInFlight) {
      return "A curator pass is already running.";
    }
    const io = this.skillIo;
    const usage = this.skillUsage;
    const settings = this.config.getCuratorSettings();
    const now = Date.now();
    const dryRun = options.dryRun ?? false;
    const start = Date.now();
    this.curatorInFlight = true;
    this.inBackgroundReview = true;
    try {
      let backupNote = "";
      if (!dryRun && settings.backupEnabled) {
        const info = await snapshotSkills(io, now, settings.backupKeep).catch(() => undefined);
        if (info) {
          backupNote = `backup ${info.id} (${info.fileCount} files); `;
        }
      }
      const transitions = await applyAutomaticTransitions(io, usage, settings, now, !dryRun);
      const report = await usage.agentCreatedReport();
      const consolidation = await this.runCuratorConsolidation(report, now, dryRun);
      const summaryText = `${formatTransitionSummary(transitions)}${consolidation ? `; ${consolidation}` : ""}`;
      if (!dryRun) {
        const state = await readCuratorState(io);
        state.lastRunAt = now;
        state.lastRunDurationMs = Date.now() - start;
        state.lastRunSummary = summaryText;
        state.runCount += 1;
        await writeCuratorState(io, state).catch(() => undefined);
      }
      const message = `🧹 Curator${dryRun ? " (dry run)" : ""}: ${backupNote}${summaryText}`;
      this.emit({ type: "message", role: "system", text: message });
      await this.publishState();
      return message;
    } catch (error) {
      this.recordInspector("warn", "memory", "Curator pass failed.", errorMessage(error));
      return `Curator pass failed: ${errorMessage(error)}`;
    } finally {
      this.inBackgroundReview = false;
      this.curatorInFlight = false;
    }
  }

  private async runCuratorConsolidation(report: readonly SkillUsageReportRow[], nowMs: number, dryRun: boolean): Promise<string> {
    if (dryRun || report.length === 0 || !this.skillManager) {
      return "";
    }
    const messages: ChatMessage[] = [
      { role: "system", content: `${CURATOR_REVIEW_PROMPT}\n\n${REVIEW_TOOL_HINT}` },
      {
        role: "user",
        content: `Candidate agent-created skills:\n${formatCandidateList(report, nowMs)}\n\nConsolidate now. Use skills_list / skill_view to inspect, then skill_manage to patch/create/write_file and to archive (action=delete) absorbed siblings. Finish with the structured summary block.`
      }
    ];
    const abort = new AbortController();
    const provider = await this.createProvider();
    const model = await this.resolveModel(provider, abort.signal);
    const capabilities = await this.capabilities(provider, model, abort.signal);
    const tools = capabilities.nativeToolCalls ? this.reviewToolSchemas().filter((tool) => tool.name.startsWith("skill")) : undefined;
    let lastContent = "";
    let ops = 0;

    for (let iteration = 0; iteration < maxCuratorIterations; iteration++) {
      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const event of this.streamChatWithIdleTimeout(provider, {
        model,
        messages,
        tools,
        temperature: 0,
        maxTokens: this.requestMaxTokens(),
        signal: abort.signal
      }, abort, "Curator consolidation")) {
        if (event.type === "content") {
          content += event.text;
        } else if (event.type === "toolCalls") {
          toolCalls.push(...event.toolCalls);
        }
      }
      lastContent = content || lastContent;

      if (toolCalls.length === 0) {
        for (const action of reviewActionsFromText(content).filter((a) => a.name.startsWith("skill"))) {
          await this.executeReviewTool(action.name, action.args);
          ops += 1;
        }
        break;
      }
      messages.push({ role: "assistant", content, toolCalls });
      for (const toolCall of toolCalls) {
        const result = await this.executeReviewTool(toolCall.name, safeParseArgs(toolCall.argumentsJson));
        if (toolCall.name === "skill_manage") {
          ops += 1;
        }
        messages.push({ role: "tool", content: result.output, toolCallId: toolCall.id, name: toolCall.name });
      }
    }

    const parsed = parseCuratorSummary(lastContent);
    if (ops === 0 && parsed.consolidations.length === 0 && parsed.prunings.length === 0) {
      return "";
    }
    return `consolidated ${parsed.consolidations.length} · pruned ${parsed.prunings.length}`;
  }

  /** Slash-command surface: /curator status|run|pause|resume|pin|unpin|archive|restore|backup|rollback|list-archived. */
  async handleCuratorCommand(rest: string): Promise<void> {
    if (!this.skillIo || !this.skillUsage || !this.skillManager) {
      this.emit({ type: "error", text: "Skills are not available in this environment." });
      return;
    }
    const io = this.skillIo;
    const usage = this.skillUsage;
    const settings = this.config.getCuratorSettings();
    const [verb, ...args] = rest.trim().split(/\s+/).filter(Boolean);
    const arg = args.filter((value) => !value.startsWith("--")).join(" ");
    const dryRun = args.includes("--dry-run");

    switch (verb ?? "status") {
      case "status": {
        const state = await readCuratorState(io);
        const report = await usage.agentCreatedReport();
        const byState = (s: string) => report.filter((row) => row.state === s).length;
        const pinned = report.filter((row) => row.pinned).map((row) => row.name);
        const last = state.lastRunAt ? new Date(state.lastRunAt).toISOString() : "never";
        this.emit({
          type: "message",
          role: "system",
          text:
            `🧹 Curator: ${settings.enabled ? (state.paused ? "PAUSED" : "enabled") : "disabled"}\n` +
            `runs: ${state.runCount} · last run: ${last}\n` +
            `last summary: ${state.lastRunSummary ?? "—"}\n` +
            `interval: ${settings.intervalHours}h · stale after ${settings.staleAfterDays}d · archive after ${settings.archiveAfterDays}d\n` +
            `agent-created skills: ${report.length} (active ${byState("active")}, stale ${byState("stale")}, archived ${byState("archived")})\n` +
            `pinned (${pinned.length}): ${pinned.join(", ") || "none"}`
        });
        return;
      }
      case "run":
        await this.runCurator({ dryRun });
        return;
      case "pause": {
        const state = await readCuratorState(io);
        state.paused = true;
        await writeCuratorState(io, state);
        this.emit({ type: "status", text: "Curator paused." });
        return;
      }
      case "resume": {
        const state = await readCuratorState(io);
        state.paused = false;
        await writeCuratorState(io, state);
        this.emit({ type: "status", text: "Curator resumed." });
        return;
      }
      case "pin":
        if (!arg) {
          this.emit({ type: "error", text: "Usage: /curator pin <skill>" });
          return;
        }
        await usage.setPinned(arg, true);
        this.emit({ type: "status", text: `Pinned skill ${arg} (protected from auto-archive).` });
        return;
      case "unpin":
        if (!arg) {
          this.emit({ type: "error", text: "Usage: /curator unpin <skill>" });
          return;
        }
        await usage.setPinned(arg, false);
        this.emit({ type: "status", text: `Unpinned skill ${arg}.` });
        return;
      case "archive": {
        if (!arg) {
          this.emit({ type: "error", text: "Usage: /curator archive <skill>" });
          return;
        }
        const result = JSON.parse(await this.skillManager.handleManage({ action: "delete", name: arg, absorbed_into: "" }));
        this.emit({ type: result.success ? "status" : "error", text: result.message ?? result.error ?? "" });
        await this.publishState();
        return;
      }
      case "restore": {
        if (!arg) {
          this.emit({ type: "error", text: "Usage: /curator restore <skill>" });
          return;
        }
        if (!(await io.exists(archivedSkillDirPath(arg)))) {
          this.emit({ type: "error", text: `No archived skill '${arg}'.` });
          return;
        }
        await io.move(archivedSkillDirPath(arg), skillDirPath(arg));
        await usage.setState(arg, "active");
        this.emit({ type: "status", text: `Restored skill ${arg}.` });
        await this.publishState();
        return;
      }
      case "list-archived": {
        const archived = (await usage.report()).filter((row) => row.state === "archived").map((row) => row.name);
        this.emit({ type: "message", role: "system", text: `Archived skills (${archived.length}): ${archived.join(", ") || "none"}` });
        return;
      }
      case "backup": {
        const info = await snapshotSkills(io, Date.now(), settings.backupKeep);
        this.emit({ type: "status", text: `Backed up ${info.fileCount} skill file(s) as ${info.id}.` });
        return;
      }
      case "rollback": {
        const ids = await listBackups(io);
        if (!arg && ids.length === 0) {
          this.emit({ type: "error", text: "No curator backups to roll back to." });
          return;
        }
        const id = arg || ids[ids.length - 1];
        const result = await rollbackSkills(io, id, Date.now(), settings.backupKeep);
        this.emit({ type: result.ok ? "status" : "error", text: result.message });
        await this.publishState();
        return;
      }
      default:
        this.emit({ type: "error", text: `Unknown curator command '${verb}'. Try: status, run, pause, resume, pin, unpin, archive, restore, list-archived, backup, rollback.` });
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

    const result = compactOldToolResults(this.messages, {
      maxBytes: this.contextWindowMaxBytes(),
      triggerRatio: contextAutoCompactPercent / 100,
      targetRatio: contextToolResultTargetRatio
    });
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
    if (this.providerFactory) {
      return this.providerFactory();
    }
    const profile = await this.config.getActiveProfile();
    return new OpenAiCompatibleProvider(profile, this.config.getNetworkPolicy(), {
      streamCompletionGraceMs: this.config.getStreamCompletionGraceSeconds() * 1000,
      maxRateLimitRetries: this.config.getRateLimitRetries()
    });
  }

  private async resolveModel(provider: LlmProvider, signal: AbortSignal): Promise<string> {
    const cachedInspection = this.endpointCache.get(provider.profile.id);
    if (cachedInspection) {
      const configured = this.selectedModelFor(provider.profile, cachedInspection);
      if (configured) {
        return configured;
      }
    }

    let inspection: OpenAiEndpointInspection;
    try {
      inspection = await provider.inspectEndpoint(signal);
    } catch (error) {
      const configured = this.selectedModelFor(provider.profile);
      if (configured) {
        return configured;
      }
      throw error;
    }
    this.endpointCache.set(provider.profile.id, inspection);
    if (inspection.models.length === 0) {
      throw new Error("No model is configured and the endpoint did not return any models.");
    }
    this.notifyIfSelectedModelUnavailable(provider.profile, inspection);
    return this.selectedModelFor(provider.profile, inspection);
  }

  private async capabilities(provider: LlmProvider, model: string, signal: AbortSignal): Promise<ProviderCapabilities> {
    const key = `${provider.profile.id}:${model}`;
    const cached = this.capabilityCache.get(key);
    if (cached) {
      return cached;
    }

    const persisted = await this.endpointCapabilityStore?.get(provider.profile.id, provider.profile.baseUrl, model);
    if (persisted && isFreshCapability(persisted)) {
      this.capabilityCache.set(key, persisted.capabilities);
      this.recordInspector("info", "endpoint", `Loaded cached capabilities for ${model}.`, `Native tools: ${persisted.capabilities.nativeToolCalls ? "yes" : "no"}\nStreaming: ${persisted.capabilities.streaming ? "yes" : "no"}`);
      return persisted.capabilities;
    }

    const capabilities = await provider.probeCapabilities(model, signal);
    this.capabilityCache.set(key, capabilities);
    const inspection = this.endpointCache.get(provider.profile.id);
    void this.endpointCapabilityStore?.upsert({
      profileId: provider.profile.id,
      baseUrl: provider.profile.baseUrl,
      model,
      backendLabel: inspection?.backendLabel,
      modelInfo: inspection?.models.find((item) => item.id === model),
      capabilities,
      checkedAt: Date.now()
    });
    this.recordInspector("info", "endpoint", `Probed capabilities for ${model}.`, `Native tools: ${capabilities.nativeToolCalls ? "yes" : "no"}\nStreaming: ${capabilities.streaming ? "yes" : "no"}`);
    return capabilities;
  }

  private async toolDefinitionsForRequest(mode: AgentMode, mcpToolBindings: Map<string, McpToolBinding>, signal: AbortSignal): Promise<readonly ToolDefinition[]> {
    const allowedTools = [...toolDefinitionsForAgentMode(mode)];
    const loadedToolNames = new Set(mode === "agent" ? coreAgentToolNames : coreReadOnlyToolNames);
    for (const toolName of discoveredCodeForgeToolNames(this.messages)) {
      loadedToolNames.add(toolName);
    }
    const baseTools = allowedTools.filter((tool) => loadedToolNames.has(tool.name));
    if (mode !== "agent" || this.config.getMcpServers().length === 0) {
      return baseTools;
    }

    const loadedMcpToolNames = discoveredMcpToolNames(this.messages);
    if (loadedMcpToolNames.size === 0) {
      return baseTools;
    }

    try {
      const inspections = await inspectConfiguredMcpServers(
        this.config.getMcpServers(),
        this.config.getNetworkPolicy(),
        undefined,
        signal
      );
      const usedNames = new Set(baseTools.map((tool) => tool.name));
      const mcpTools: ToolDefinition[] = [];
      for (const inspection of inspections) {
        if (inspection.error || !inspection.status.valid || !inspection.status.enabled) {
          continue;
        }
        for (const tool of inspection.tools) {
          const name = mcpFunctionName(inspection.status.id, tool.name, usedNames);
          usedNames.add(name);
          if (!loadedMcpToolNames.has(name)) {
            continue;
          }
          mcpToolBindings.set(name, { serverId: inspection.status.id, toolName: tool.name });
          mcpTools.push({
            name,
            description: [
              `Call MCP tool ${tool.name} on configured server ${inspection.status.id}.`,
              tool.description
            ].filter((line): line is string => Boolean(line)).join(" "),
            parameters: mcpToolParameters(tool.inputSchema)
          });
        }
      }
      return [...baseTools, ...mcpTools];
    } catch {
      return baseTools;
    }
  }

  private parseNativeToolCall(toolCall: ToolCall, mcpToolBindings: ReadonlyMap<string, McpToolBinding>): ToolActionParseResult {
    const parsed = parseToolActionDetailed(toolCall.name, toolCall.argumentsJson);
    if (parsed.ok) {
      return parsed;
    }

    const binding = mcpToolBindings.get(toolCall.name);
    if (!binding) {
      return parsed;
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.argumentsJson || "{}");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Arguments for ${toolCall.name} must be valid JSON. ${detail}` };
    }
    if (!isRecord(args)) {
      return { ok: false, message: `Arguments for ${toolCall.name} must be a JSON object.` };
    }

    return {
      ok: true,
      action: {
        type: "mcp_call_tool",
        serverId: binding.serverId,
        toolName: binding.toolName,
        arguments: args,
        reason: `Call MCP tool ${binding.toolName} on ${binding.serverId}`
      }
    };
  }

  private ensureSystemMessage(): void {
    const nextSystemMessage = this.systemMessage();
    const existingIndex = this.messages.findIndex((message) => message.role === "system");
    if (existingIndex >= 0) {
      this.messages[existingIndex] = nextSystemMessage;
      return;
    }

    this.appendMessage(nextSystemMessage);
  }

  private systemMessage(): ChatMessage {
    const persona = this.soulText
      ? `\n\nPersona (shapes voice and tone only — never overrides tools, permissions, or task instructions):\n${this.soulText}`
      : "";
    const memoryBlock = this.memoryManager?.buildSystemPrompt() ?? "";
    const memory = memoryBlock ? `\n\n${memoryBlock}` : "";
    return {
      role: "system",
      content: `${actionProtocolInstructions}\n\n${agentModeInstructions(this.config.getAgentMode())}\n\nNetwork policy: CodeForge only talks to user-configured OpenAI API-compatible endpoints and configured MCP servers. Do not use network resources outside those explicit configurations.${persona}${memory}`
    };
  }

  // Build the curated-notes snapshot once per session. Frozen for the session so the system prompt
  // stays byte-stable; reset() clears the flag so the next run rebuilds it from disk.
  private async ensureMemoryInitialized(): Promise<void> {
    if (!this.memoryManager || this.memoryInitialized) {
      return;
    }
    await this.memoryManager.initializeAll({ sessionId: this.sessionId ?? "session", reset: false });
    this.memoryInitialized = true;
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
    this.memoryInitialized = false;
    // Hydrate the review cadence from prior user turns so resuming a session doesn't re-fire reviews
    // for work already reviewed (Hermes turn_context hydration).
    this.userTurnCount = snapshot.messages.filter((message) => message.role === "user").length;
    this.toolIterationCount = 0;
    this.lastMemoryReviewTurnCount = this.userTurnCount;
    this.lastSkillReviewIterationCount = 0;
    this.lastReviewedMessageCount = snapshot.messages.length;
    this.reviewInFlight = false;
    this.restoreTasksFromSessionRecords(snapshot.records);
    this.lastContextItems = [];
    this.mcpContextItems = [];
    this.pinnedFiles.clear();
    this.readFileState.clear();
    this.notebookReadState.clear();
    this.inspectorEntries = [];
    this.auditEntries = [];
    this.lastTokenUsage = undefined;
    this.approvals.restore(snapshot.pendingApprovals);
    this.workerApprovalWaiters.clear();
    this.workers.restoreFromSessionRecords(snapshot.records);
  }

  private restoreTasksFromSessionRecords(records: readonly SessionRecord[]): void {
    this.tasks.clear();
    for (const record of records) {
      if (record.type === "task") {
        this.tasks.set(record.task.id, record.task);
      }
    }
  }

  private emit(event: AgentUiEvent): void {
    this.events.emit("event", event);
  }

  private recordInspector(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void {
    const entry: AgentInspectorEntry = {
      id: `inspect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      level,
      category,
      summary,
      detail
    };
    this.inspectorEntries = [entry, ...this.inspectorEntries].slice(0, 200);
    this.emitInspector();
  }

  private recordAudit(action: AgentAction, decision: PermissionDecision, outcome: AgentAuditEntry["outcome"]): void {
    const entry: AgentAuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      action: action.type,
      behavior: decision.behavior,
      source: decision.source,
      reason: decision.reason,
      outcome,
      summary: toolSummary(action)
    };
    this.auditEntries = [entry, ...this.auditEntries].slice(0, 200);
    this.emitInspector();
  }

  private emitInspector(): void {
    this.emit({ type: "inspector", inspector: this.inspectorSummary() });
  }

  private inspectorSummary(): AgentInspectorSummary {
    return {
      entries: this.inspectorEntries,
      audit: this.auditEntries
    };
  }

  private async handleSlashCommand(rawPrompt: string): Promise<void> {
    const [commandWithSlash, ...args] = rawPrompt.trim().split(/\s+/);
    const command = commandWithSlash.toLowerCase();
    const rest = args.join(" ");
    const permissionMode = permissionModeFromSlashCommand(command);
    if (permissionMode) {
      await this.setPermissionModeFromSlash(permissionMode);
      return;
    }

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
      case "/curator":
        await this.handleCuratorCommand(rest);
        return;
      case "/context": {
        this.emit({ type: "message", role: "system", text: this.formatContextReport() });
        this.emitContextUsage();
        return;
      }
      case "/doctor":
        await this.runDoctor();
        return;
      case "/index":
        await this.showWorkspaceIndex();
        return;
      case "/pin":
        if (rest) {
          await this.pinFile(rest);
        } else {
          await this.pinActiveFile();
        }
        return;
      case "/unpin":
        await this.unpinFile(rest || undefined);
        return;
      case "/pins":
        this.emit({ type: "message", role: "system", text: this.formatPinnedFilesReport() });
        return;
      case "/inspect":
      case "/inspector":
        this.emitInspector();
        this.emit({ type: "message", role: "system", text: this.formatInspectorReport() });
        return;
      case "/audit":
        this.emitInspector();
        this.emit({ type: "message", role: "system", text: this.formatAuditReport() });
        return;
      case "/capabilities":
        this.emit({ type: "message", role: "system", text: await this.formatCapabilityReport() });
        return;
      case "/commands":
        await this.showLocalCommands();
        return;
      case "/mcp":
        await this.handleMcpCommand(rest);
        return;
      case "/workers":
        this.showWorkers();
        return;
      case "/worker":
        await this.handleWorkerCommand(rest);
        return;
      case "/agents":
        await this.showLocalAgents();
        return;
      case "/review":
        await this.runReviewCommand(rest);
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
      case "/models":
        if (rest) {
          await this.selectModel(rest);
          this.emit({ type: "message", role: "system", text: `Model set to ${rest}.` });
        } else {
          await this.refreshModels();
          this.emit({ type: "message", role: "system", text: this.formatModelReport() });
        }
        return;
      case "/agent":
      case "/auto":
        await this.setAgentMode("agent");
        if (rest) {
          await this.runPrompt(rest, rest);
        }
        return;
      case "/ask":
        await this.setAgentMode("ask");
        if (rest) {
          await this.runPrompt(rest, rest);
        }
        return;
      case "/plan":
        await this.setAgentMode("plan");
        if (rest) {
          await this.runPrompt(rest, rest);
        }
        return;
      default:
        if (await this.tryLocalSlashCommand(command.slice(1), rest, rawPrompt.trim())) {
          return;
        }
        this.emit({
          type: "message",
          role: "system",
          text: `Unknown command ${command}. Available commands: /new, /compact, /curator, /context, /doctor, /index, /pin, /unpin, /pins, /inspect, /audit, /capabilities, /commands, /mcp, /workers, /worker, /agents, /review, /skills, /skill, /memory, /clear, /stop, /history, /resume, /fork, /diff, /export, /model, /models, /agent, /ask, /plan, /manual, /smart, /full-auto, /config.`
        });
    }
  }

  private async setPermissionModeFromSlash(mode: PermissionMode): Promise<void> {
    // setPermissionMode already emits the "Permission mode set to ..." confirmation from the
    // persisted value, so the slash path just delegates.
    await this.setPermissionMode(mode);
  }

  private async showLocalCommands(): Promise<void> {
    const commands = await loadLocalCommands(this.workspace);
    this.emit({ type: "message", role: "system", text: formatLocalCommandList(commands) });
  }

  private async runReviewCommand(scope: string): Promise<void> {
    const target = scope.trim() || "the current branch, workspace changes, or relevant repo context";
    await this.runPrompt(`/review ${scope}`.trim(), reviewCommandPrompt(target));
  }

  private emitWorkerStarted(worker: WorkerSummary): void {
    this.emit({
      type: "message",
      role: "system",
      text: `${worker.label} worker started: ${worker.id}\n\nUse /worker output ${worker.id} to view its transcript or /worker stop ${worker.id} to stop it.`
    });
  }

  private showWorkers(): void {
    const workers = this.workers.list();
    this.emit({ type: "workers", workers });
    this.emit({ type: "message", role: "system", text: formatWorkerList(workers) });
  }

  private async handleWorkerCommand(rest: string): Promise<void> {
    const [subcommandRaw, ...tail] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "list";
    switch (subcommand) {
      case "list":
      case "status":
        this.showWorkers();
        return;
      case "output":
      case "show":
      case "open": {
        const workerId = tail[0];
        if (!workerId) {
          this.emit({ type: "message", role: "system", text: "Usage: /worker output <worker-id>" });
          return;
        }
        this.showWorkerOutput(workerId);
        return;
      }
      case "attach": {
        const workerId = tail[0];
        if (!workerId) {
          this.emit({ type: "message", role: "system", text: "Usage: /worker attach <worker-id>" });
          return;
        }
        this.attachWorkerOutput(workerId);
        return;
      }
      case "stop":
      case "cancel": {
        const workerId = tail[0];
        if (!workerId) {
          this.emit({ type: "message", role: "system", text: "Usage: /worker stop <worker-id>" });
          return;
        }
        this.stopWorker(workerId);
        return;
      }
      case "help":
        this.emit({ type: "message", role: "system", text: workerCommandList() });
        return;
      default:
        this.emit({ type: "message", role: "system", text: workerCommandList() });
    }
  }

  private async handleMcpCommand(rest: string): Promise<void> {
    const [subcommandRaw, serverIdRaw, ...tail] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "status";
    const serverId = serverIdRaw || undefined;
    switch (subcommand) {
      case "status":
      case "list":
      case "servers":
        this.showMcpServers();
        return;
      case "tools":
        await this.showMcpInspection("tools", serverId);
        return;
      case "resources":
        await this.showMcpInspection("resources", serverId);
        return;
      case "attach":
      case "select": {
        const uri = tail.join(" ").trim();
        if (!serverId || !uri) {
          this.emit({ type: "message", role: "system", text: "Usage: /mcp attach <server-id> <resource-uri>" });
          return;
        }
        await this.attachMcpResource(serverId, uri);
        return;
      }
      case "detach":
      case "remove": {
        const uri = tail.join(" ").trim();
        if (!serverId) {
          this.emit({ type: "message", role: "system", text: "Usage: /mcp detach <server-id> <resource-uri|all>" });
          return;
        }
        this.detachMcpResource(serverId, uri || "all");
        return;
      }
      case "clear":
        this.mcpContextItems = [];
        this.emit({ type: "message", role: "system", text: "Cleared attached MCP resources from this chat context." });
        this.emitContextUsage();
        await this.publishState();
        return;
      default:
        this.emit({ type: "message", role: "system", text: "Usage: /mcp status, /mcp tools [server-id], /mcp resources [server-id], /mcp attach <server-id> <resource-uri>, /mcp detach <server-id> <resource-uri|all>, or /mcp clear." });
    }
  }

  private showMcpServers(): void {
    const statuses = configuredMcpServerStatuses(this.config.getMcpServers(), this.config.getNetworkPolicy());
    if (statuses.length === 0) {
      this.emit({ type: "message", role: "system", text: "No MCP servers are configured. Add explicit servers in CodeForge settings before using MCP tools." });
      return;
    }

    const lines = statuses.map((server) => {
      const state = server.enabled ? server.valid ? "ready" : "blocked" : "disabled";
      const target = server.target ? ` ${server.target}` : "";
      const reason = server.reason ? ` - ${server.reason}` : "";
      return `- ${server.id} (${server.label}) ${server.transport}${target}: ${state}${reason}`;
    });
    this.emit({ type: "message", role: "system", text: `Configured MCP servers:\n${lines.join("\n")}` });
  }

  private async showMcpInspection(kind: "tools" | "resources", serverId: string | undefined): Promise<void> {
    const inspections = await inspectConfiguredMcpServers(
      this.config.getMcpServers(),
      this.config.getNetworkPolicy(),
      serverId,
      this.runningAbort?.signal
    );
    this.emit({ type: "mcpProbe", inspections: inspections.map(toAgentMcpInspectionSummary) });
    this.emit({ type: "message", role: "system", text: formatMcpInspectionReport(inspections, kind) });
    await this.publishState();
  }

  async attachMcpResource(serverId: string, uri: string, servers = this.config.getMcpServers()): Promise<void> {
    try {
      const resource = await readConfiguredMcpResource(
        servers,
        this.config.getNetworkPolicy(),
        serverId,
        uri,
        this.runningAbort?.signal
      );
      const label = `${resource.serverId}:${resource.uri}`;
      this.mcpContextItems = [
        ...this.mcpContextItems.filter((item) => item.label !== label),
        {
          kind: "mcpResource",
          label,
          content: resource.content
        }
      ];
      this.emit({ type: "message", role: "system", text: `Attached MCP resource ${label} to this chat context.` });
      this.emitContextUsage();
      await this.publishState();
    } catch (error) {
      this.emit({ type: "error", text: errorMessage(error) });
    }
  }

  detachMcpResource(serverId: string, uri: string): void {
    const before = this.mcpContextItems.length;
    this.mcpContextItems = uri === "all"
      ? this.mcpContextItems.filter((item) => !item.label.startsWith(`${serverId}:`))
      : this.mcpContextItems.filter((item) => item.label !== `${serverId}:${uri}`);
    const removed = before - this.mcpContextItems.length;
    this.emit({
      type: "message",
      role: "system",
      text: removed > 0 ? `Detached ${removed} MCP resource(s).` : "No matching MCP resource was attached."
    });
    this.emitContextUsage();
    void this.publishState();
  }

  private async showLocalSkills(): Promise<void> {
    const skills = await loadLocalSkills(this.workspace);
    this.emit({ type: "message", role: "system", text: formatLocalSkillList(skills) });
  }

  private async showLocalAgents(): Promise<void> {
    const agents = await loadLocalAgents(this.workspace);
    this.emit({ type: "message", role: "system", text: formatLocalAgentList(agents) });
  }

  private async executeSpawnAgentAction(action: Extract<AgentAction, { readonly type: "spawn_agent" }>): Promise<string> {
    const definition = await this.resolveSpawnAgentDefinition(action.agent);
    const worker = this.workers.spawnDefinition(definition, action.prompt);
    this.emitWorkerStarted(worker);
    if (action.background === true) {
      return `spawn_agent ${worker.id}\n\nLaunched ${worker.label} in the background. Use worker_output with workerId "${worker.id}" to inspect progress.`;
    }

    const completed = await this.workers.waitFor(worker.id, 120000, this.runningAbort?.signal);
    const output = this.workers.output(worker.id);
    if (!completed || completed.status === "running") {
      return `spawn_agent ${worker.id}\n\n${worker.label} is still running after the foreground wait window. Use worker_output with workerId "${worker.id}" to inspect progress.\n\n${output ?? ""}`.trim();
    }
    return output ?? `spawn_agent ${worker.id}\n\n${worker.label} finished with status ${completed.status}.`;
  }

  private async resolveSpawnAgentDefinition(name: string | undefined): Promise<WorkerDefinition> {
    const normalized = name?.trim().toLowerCase() || "implement";
    const builtInName = normalized === "general" || normalized === "general-purpose" || normalized === "agent"
      ? "implement"
      : normalized;
    if (isWorkerKind(builtInName) && builtInName !== "custom") {
      const definition = findWorkerDefinition(builtInName);
      if (definition) {
        return definition;
      }
    }

    const agents = await loadLocalAgents(this.workspace);
    const agent = agents.find((item) => item.name.toLowerCase() === normalized);
    if (!agent) {
      throw new Error(`No CodeForge agent named ${normalized}. Built-ins: explore, plan, review, verify, implement. Local agents: ${agents.map((item) => item.name).join(", ") || "none"}.`);
    }
    return localAgentWorkerDefinition(agent);
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
    this.workerApprovalWaiters.clear();
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

  private async showWorkspaceIndex(): Promise<void> {
    try {
      const index = await buildWorkspaceIndex(this.workspace, {
        maxFiles: 500,
        maxAnalyzedFiles: 80,
        maxBytesPerFile: 16000
      }, this.runningAbort?.signal);
      this.emit({
        type: "message",
        role: "system",
        text: index ? `Repo index:\n\n${index.content}` : "Repo index:\n\nNo repo files found."
      });
    } catch (error) {
      this.emit({ type: "error", text: `Failed to build workspace index: ${errorMessage(error)}` });
    }
  }

  private formatPinnedFilesReport(): string {
    const pinned = [...this.pinnedFiles];
    return pinned.length === 0
      ? "Pinned context files: none. The open repo folder is still used automatically; use /pin <path> only when you want to force a specific file into every request."
      : `Pinned context files:\n${pinned.map((path) => `- ${path}`).join("\n")}`;
  }

  private formatInspectorReport(): string {
    if (this.inspectorEntries.length === 0) {
      return "Run inspector:\n\nNo run events recorded yet.";
    }
    const lines = this.inspectorEntries.slice(0, 40).map((entry) => {
      const when = new Date(entry.createdAt).toLocaleTimeString();
      return `- ${when} [${entry.level}] ${entry.category}: ${entry.summary}${entry.detail ? `\n  ${firstLines(entry.detail, 4).replace(/\n/g, "\n  ")}` : ""}`;
    });
    return `Run inspector:\n${lines.join("\n")}`;
  }

  private formatAuditReport(): string {
    if (this.auditEntries.length === 0) {
      return "Permission audit:\n\nNo permission decisions recorded yet.";
    }
    const lines = this.auditEntries.slice(0, 60).map((entry) => {
      const when = new Date(entry.createdAt).toLocaleTimeString();
      return `- ${when} ${entry.action} ${entry.outcome} (${entry.behavior}/${entry.source}) - ${entry.reason}`;
    });
    return `Permission audit:\n${lines.join("\n")}`;
  }

  private async formatCapabilityReport(): Promise<string> {
    const profileId = this.config.getActiveProfileId();
    const entries = await this.capabilitySummaries(profileId);
    if (entries.length === 0) {
      return "Endpoint capability cache:\n\nNo cached model capabilities yet. Run /doctor or send a request to probe the selected model.";
    }
    const lines = entries.map((entry) => {
      const details = [
        entry.nativeToolCalls ? "native tools" : "json fallback",
        entry.streaming ? "streaming" : "non-streaming",
        entry.contextLength ? `${entry.contextLength.toLocaleString("en-US")} ctx` : undefined,
        entry.supportsReasoning ? "thinking" : undefined
      ].filter((item): item is string => Boolean(item)).join(", ");
      return `- ${entry.model} | ${details} | checked ${new Date(entry.checkedAt).toLocaleString()}`;
    });
    return `Endpoint capability cache:\n${lines.join("\n")}`;
  }

  private formatModelReport(): string {
    const activeProfileId = this.config.getActiveProfileId();
    const profile = this.config.getProfiles().find((item) => item.id === activeProfileId);
    const inspection = this.endpointCache.get(activeProfileId);
    const selectedModel = profile ? this.selectedModelFor(profile, inspection) : inspection?.models[0]?.id || "";
    const lines = [
      `Active model: ${selectedModel || "(not configured)"}.`,
      inspection?.backendLabel ? `Detected backend: ${inspection.backendLabel}.` : undefined,
      "",
      "Available models:"
    ].filter((line): line is string => line !== undefined);

    if (!inspection || inspection.models.length === 0) {
      lines.push("- No models found. Check the OpenAI API endpoint settings.");
      return lines.join("\n");
    }

    for (const model of inspection.models) {
      const details = [
        model.contextLength ? `${model.contextLength.toLocaleString("en-US")} ctx` : undefined,
        model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString("en-US")} output` : undefined,
        model.supportsReasoning ? "thinking" : undefined
      ].filter((item): item is string => Boolean(item));
      const marker = model.id === selectedModel ? "*" : "-";
      lines.push(`${marker} ${model.id}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
    }
    lines.push("", "Use `/models` to pick from the active endpoint or `/model <model-id>` to switch directly.");
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
        const lines = memories.map((memory) => {
          const scope = memory.scope === "agent" && memory.namespace ? `agent:${memory.namespace}` : memory.scope ?? "workspace";
          return `${memory.id} | ${scope} | ${new Date(memory.createdAt).toLocaleString()} | ${memory.text}`;
        });
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
    const agentMode = this.config.getAgentMode();
    const profiles = this.config.getProfiles().map((profile): AgentProfileSummary => ({
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      hasApiKey: Boolean(profile.apiKeySecretName)
    }));
    const inspection = this.endpointCache.get(activeProfile.id);
    const modelInfo = inspection?.models.map(toAgentModelSummary) ?? [];
    const models = modelInfo.map((model) => model.id);
    const selectedModel = this.selectedModelFor(activeProfile, inspection);
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
      mcpServers: configuredMcpServerStatuses(this.config.getMcpServers(), this.config.getNetworkPolicy()).map(toAgentMcpServerStatusSummary),
      mcpContext: this.mcpContextItems.map(toAgentMcpResourceContextSummary),
      workers: this.workers.list(),
      activeContext: await this.activeContextSummary(),
      memories: await this.memorySummaries(),
      capabilityCache: await this.capabilitySummaries(activeProfile.id),
      inspector: this.inspectorSummary(),
      settings: {
        agentMode,
        allowlist: networkPolicy.allowlist,
        maxFiles: contextLimits.maxFiles,
        maxTokens: contextLimits.maxTokens,
        maxBytes: contextLimits.maxBytes,
        commandTimeoutSeconds: this.config.getCommandTimeoutSeconds(),
        modelIdleTimeoutSeconds: this.config.getModelIdleTimeoutSeconds(),
        streamCompletionGraceSeconds: this.config.getStreamCompletionGraceSeconds(),
        maxInvalidToolCallRetries: this.config.getMaxInvalidToolCallRetries(),
        commandOutputLimitBytes: this.config.getCommandOutputLimitBytes(),
        permissionMode: permissionPolicy.mode,
        permissionRules: permissionPolicy.rules,
        mcpServers: this.config.getMcpServers()
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

  private async activeContextSummary(): Promise<AgentActiveContextSummary> {
    const active = await this.workspace.getActiveTextDocument(1).catch(() => undefined);
    const workspaceReady = await this.workspace.listTextFiles(1).then((files) => files.length > 0).catch(() => false);
    return {
      activeFile: active && !active.label.startsWith("Unsaved active") ? active.label : undefined,
      workspaceReady,
      pinnedFiles: [...this.pinnedFiles]
    };
  }

  private async memorySummaries(): Promise<readonly AgentMemorySummary[]> {
    if (!this.memoryStore) {
      return [];
    }
    const memories = await this.memoryStore.list().catch(() => []);
    return memories.map((memory) => ({
      id: memory.id,
      text: memory.text,
      createdAt: memory.createdAt,
      scope: memory.scope ?? "workspace",
      namespace: memory.namespace
    }));
  }

  private async capabilitySummaries(profileId: string): Promise<readonly AgentCapabilitySummary[]> {
    const entries = await this.endpointCapabilityStore?.list(profileId).catch(() => []) ?? [];
    return entries.slice(0, 20).map((entry) => ({
      profileId: entry.profileId,
      baseUrl: entry.baseUrl,
      model: entry.model,
      backendLabel: entry.backendLabel,
      nativeToolCalls: entry.capabilities.nativeToolCalls,
      streaming: entry.capabilities.streaming,
      modelListing: entry.capabilities.modelListing,
      contextLength: entry.modelInfo?.contextLength,
      supportsReasoning: entry.modelInfo?.supportsReasoning,
      checkedAt: entry.checkedAt
    }));
  }

  private emitContextUsage(): void {
    this.emit({ type: "contextUsage", usage: this.currentContextUsage() });
  }

  private currentContextUsage(): ContextUsage {
    return buildContextUsage(this.messages, this.contextWindowMaxBytes(), this.lastContextItems, {
      actualTokenUsage: this.lastTokenUsage,
      maxTokens: this.contextWindowMaxTokens()
    });
  }

  private effectiveContextLimits(): ContextLimits {
    const configured = this.config.getContextLimits();
    const maxTokens = this.contextWindowMaxTokens();
    if (!maxTokens) {
      return configured;
    }

    const usableTokens = Math.max(1024, Math.floor(maxTokens * contextAttachmentRatio));
    return {
      ...configured,
      maxBytes: Math.max(8000, usableTokens * 4)
    };
  }

  private contextWindowMaxTokens(): number | undefined {
    return this.config.getContextLimits().maxTokens ?? this.selectedModelInfo()?.contextLength;
  }

  // Bound on generated tokens for every model turn, honoring codeforge.model.maxOutputTokens
  // (0 = no limit, >=1 = cap; defaults to 32k, safely bounded). Returns undefined when no limit, so
  // no max_tokens is sent and the endpoint decides (on vLLM, up to the remaining context window).
  private requestMaxTokens(): number | undefined {
    return resolveRequestMaxTokens(
      this.selectedModelInfo(),
      this.config.getContextLimits().maxTokens,
      this.config.getMaxOutputTokensPreference()
    );
  }

  private contextWindowMaxBytes(): number {
    const maxTokens = this.contextWindowMaxTokens();
    return maxTokens ? Math.max(8000, maxTokens * 4) : this.config.getContextLimits().maxBytes;
  }

  private selectedModelInfo(): ModelInfo | undefined {
    const activeProfileId = this.config.getActiveProfileId();
    const inspection = this.endpointCache.get(activeProfileId);
    if (!inspection) {
      return undefined;
    }

    const profile = this.config.getProfiles().find((item) => item.id === activeProfileId);
    const selectedModel = profile ? this.selectedModelFor(profile, inspection) : inspection.models[0]?.id || "";
    return inspection.models.find((model) => model.id === selectedModel);
  }

  private selectedModelFor(profile: ProviderProfile, inspection?: OpenAiEndpointInspection): string {
    const selected = this.selectedModelByProfile.get(profile.id);
    if (selected) {
      return selected;
    }

    const configured = this.config.getConfiguredModel() || profile.defaultModel || "";
    const resolution = resolveConfiguredModelId(configured, inspection?.models ?? []);
    if (resolution.unmatched) {
      this.warnUnmatchedConfiguredModel(profile, resolution.id);
    }
    return resolution.id;
  }

  // Surfaces a single, deduplicated warning when a non-empty configured model id is not present in
  // the endpoint's model list. We deliberately keep the configured id (see resolveConfiguredModelId)
  // rather than silently swapping to models[0], so the model the user intends is the model sent.
  private warnUnmatchedConfiguredModel(profile: ProviderProfile, configured: string): void {
    const key = `${profile.id}:${configured}`;
    if (this.warnedUnmatchedModels.has(key)) {
      return;
    }
    this.warnedUnmatchedModels.add(key);
    this.recordInspector(
      "warn",
      "endpoint",
      `Configured model "${configured}" was not found in the endpoint's model list.`,
      "Sending the configured id anyway. Single-model servers (e.g. llama.cpp) ignore the requested id and serve their loaded model. If this is wrong, pick a model from the dropdown."
    );
  }

  // Emit a one-time, visible chat notice when the model the user has selected is not actually served
  // by the endpoint, so a stale or removed selection does not silently fail. Stays quiet for a
  // single-model server (generic openai-api with one model), which serves its loaded model regardless
  // of the requested id; routers like LiteLLM/vLLM reject unknown ids, so they always warn.
  private notifyIfSelectedModelUnavailable(profile: ProviderProfile, inspection: OpenAiEndpointInspection): void {
    if (inspection.models.length === 0) {
      return;
    }
    const selected = this.selectedModelFor(profile, inspection);
    if (!selected) {
      return;
    }
    const needle = selected.trim().toLowerCase();
    const available = inspection.models.some((model) =>
      model.id.trim().toLowerCase() === needle
      || (model.aliases ?? []).some((alias) => alias.trim().toLowerCase() === needle)
    );
    const key = `${profile.id}:${selected}`;
    if (available) {
      // Re-arm the notice so a later disappearance of this model warns again.
      this.unavailableModelNoticed.delete(key);
      return;
    }
    const isRouter = inspection.backend === "litellm" || inspection.backend === "vllm";
    if (inspection.models.length === 1 && !isRouter) {
      return;
    }
    if (this.unavailableModelNoticed.has(key)) {
      return;
    }
    this.unavailableModelNoticed.add(key);
    this.emit({
      type: "message",
      role: "system",
      text: `⚠️ The selected model “${selected}” is currently unavailable — ${profile.label} did not return it from /v1/models. Pick an available model from the dropdown to continue.`
    });
  }
}

interface ModelIdResolution {
  readonly id: string;
  // True when a NON-EMPTY configured id was provided but matched no returned model id/alias.
  readonly unmatched: boolean;
}

// Pure, dependency-free resolution of a configured/persisted model id against the endpoint's
// returned models. Exported for unit testing.
//
// Rules:
// 1. Empty configured id with a model list -> fall back to models[0] (preserves prior behavior;
//    lets single-model servers "just work" when nothing is configured).
// 2. Non-empty configured id -> match tolerantly against each model's canonical id AND its aliases,
//    trimmed and case-insensitively, returning the CANONICAL returned id on a match.
// 3. Non-empty configured id that matches nothing -> KEEP the configured id (do NOT swap to
//    models[0]) and flag it unmatched so the caller can warn once. This guarantees the model the
//    user intends is the model actually sent, deterministically, from the first turn after startup.
export function resolveConfiguredModelId(
  configured: string,
  models: readonly ModelInfo[]
): ModelIdResolution {
  const trimmed = configured.trim();
  if (!trimmed) {
    return { id: models[0]?.id ?? "", unmatched: false };
  }
  const needle = trimmed.toLowerCase();
  for (const model of models) {
    if (model.id.trim().toLowerCase() === needle) {
      return { id: model.id, unmatched: false };
    }
    for (const alias of model.aliases ?? []) {
      if (alias.trim().toLowerCase() === needle) {
        return { id: model.id, unmatched: false };
      }
    }
  }
  return { id: trimmed, unmatched: models.length > 0 };
}

function toAgentModelSummary(model: ModelInfo): AgentModelSummary {
  return {
    id: model.id,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    supportsReasoning: model.supportsReasoning
  };
}

function originLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl;
  }
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

function toAgentMcpServerStatusSummary(status: McpServerStatus): AgentMcpServerStatusSummary {
  return {
    id: status.id,
    label: status.label,
    enabled: status.enabled,
    transport: status.transport,
    target: status.target,
    valid: status.valid,
    reason: status.reason
  };
}

function toAgentMcpInspectionSummary(inspection: McpServerInspection): AgentMcpInspectionSummary {
  return {
    server: toAgentMcpServerStatusSummary(inspection.status),
    tools: inspection.tools.map(toAgentMcpToolSummary),
    resources: inspection.resources.map(toAgentMcpResourceSummary),
    error: inspection.error
  };
}

function toAgentMcpToolSummary(tool: McpToolSummary): AgentMcpToolSummary {
  return {
    name: tool.name,
    description: tool.description
  };
}

function toAgentMcpResourceSummary(resource: McpResourceSummary): AgentMcpResourceSummary {
  return {
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType
  };
}

function toAgentMcpResourceContextSummary(item: ContextItem): AgentMcpResourceContextSummary {
  const [serverId, ...uriParts] = item.label.split(":");
  return {
    serverId,
    uri: uriParts.join(":"),
    label: item.label,
    bytes: Buffer.byteLength(item.content, "utf8")
  };
}

function formatMcpInspectionReport(inspections: readonly McpServerInspection[], kind: "tools" | "resources"): string {
  if (inspections.length === 0) {
    return "No MCP servers are configured.";
  }

  const lines: string[] = [];
  for (const inspection of inspections) {
    const state = inspection.status.enabled ? inspection.status.valid ? "ready" : "blocked" : "disabled";
    lines.push(`${inspection.status.id} (${inspection.status.label}) ${inspection.status.transport}: ${state}`);
    if (inspection.error) {
      lines.push(`  Error: ${inspection.error}`);
      continue;
    }
    if (kind === "tools") {
      if (inspection.tools.length === 0) {
        lines.push("  No tools reported.");
      } else {
        for (const tool of inspection.tools) {
          lines.push(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
        }
      }
    } else if (inspection.resources.length === 0) {
      lines.push("  No resources reported.");
    } else {
      for (const resource of inspection.resources) {
        const details = [resource.name, resource.mimeType].filter(Boolean).join(" | ");
        lines.push(`  - ${resource.uri}${details ? ` (${details})` : ""}`);
      }
      lines.push("  Use /mcp attach <server-id> <resource-uri> to add a resource to chat context.");
    }
  }
  return `MCP ${kind}:\n${lines.join("\n")}`;
}

function formatWorkerList(workers: readonly WorkerSummary[]): string {
  if (workers.length === 0) {
    return `${workerCommandList()}\n\nNo workers have run in this chat session.`;
  }
  const lines = workers.map((worker) => {
    const detail = [
      worker.model,
      worker.toolUseCount > 0 ? `${worker.toolUseCount} tools` : undefined,
      worker.tokenCount > 0 ? `${worker.tokenCount.toLocaleString("en-US")} tokens` : undefined,
      worker.filesInspected.length > 0 ? `${worker.filesInspected.length} files` : undefined
    ].filter((item): item is string => Boolean(item)).join(", ");
    const summary = worker.error ?? worker.summary ?? worker.prompt;
    return `- ${worker.id} | ${worker.label} | ${worker.status}${detail ? ` | ${detail}` : ""}\n  ${summary}`;
  });
  return `Workers:\n${lines.join("\n")}\n\nUse /worker output <id> to view a transcript or /worker stop <id> to stop a running worker.`;
}

function formatQuestionAnswers(questions: readonly UserQuestion[], answers: Readonly<Record<string, string>>): string {
  const lines = questions.map((question) => `- ${question.question} -> ${answers[question.question]}`);
  return `ask_user_question\n\nUser answered CodeForge's question(s):\n${lines.join("\n")}\n\nContinue with these answers in mind.`;
}

function approvalPermissionDecision(approval: ApprovalRequest): PermissionDecision {
  return {
    behavior: "ask",
    source: approval.permissionSource ?? "mode",
    reason: approval.permissionReason ?? "Approval was requested by the current permission policy."
  };
}

function firstLines(value: string, limit: number): string {
  return value.split(/\r?\n/).slice(0, limit).join("\n");
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function formatTaskLine(task: CodeForgeTask): string {
  const owner = task.owner ? ` owner=${task.owner}` : "";
  const blockedBy = task.blockedBy.length > 0 ? ` blockedBy=${task.blockedBy.join(",")}` : "";
  return `- ${task.id} [${task.status}]${owner}${blockedBy} ${task.subject}`;
}

function formatTask(task: CodeForgeTask): string {
  return [
    `ID: ${task.id}`,
    `Status: ${task.status}`,
    `Subject: ${task.subject}`,
    task.description ? `Description: ${task.description}` : undefined,
    task.activeForm ? `Active: ${task.activeForm}` : undefined,
    task.owner ? `Owner: ${task.owner}` : undefined,
    task.blocks.length > 0 ? `Blocks: ${task.blocks.join(", ")}` : undefined,
    task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.join(", ")}` : undefined,
    task.metadata && Object.keys(task.metadata).length > 0 ? `Metadata: ${JSON.stringify(task.metadata)}` : undefined,
    `Created: ${new Date(task.createdAt).toISOString()}`,
    `Updated: ${new Date(task.updatedAt).toISOString()}`,
    task.completedAt ? `Completed: ${new Date(task.completedAt).toISOString()}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n");
}

const localAgentReadTools = ["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics", "tool_search", "tool_list"] as const;
const localAgentCodeIntelTools = ["code_hover", "code_definition", "code_references", "code_symbols"] as const;
const localAgentNotebookReadTools = ["notebook_read"] as const;
const localAgentNotebookEditTools = ["notebook_edit_cell"] as const;
const localAgentStateTools = ["tool_search", "tool_list", "task_create", "task_update", "task_list", "task_get"] as const;
const localAgentQuestionTools = ["ask_user_question"] as const;
const localAgentEditTools = ["open_diff", "propose_patch", "write_file", "edit_file"] as const;
const localAgentCommandTools = ["run_command"] as const;
const localAgentMcpTools = ["mcp_call_tool", "mcp_list_resources", "mcp_read_resource"] as const;
const localAgentAutomationTools = ["spawn_agent", "worker_output"] as const;
const localAgentMemoryTools = ["memory", "fact_store", "fact_feedback"] as const;
const localAgentSkillTools = ["skill_manage", "skill_view", "skills_list"] as const;

function localAgentWorkerDefinition(agent: LocalAgent): WorkerDefinition {
  const label = agent.label?.trim() || agent.name;
  return {
    kind: "custom",
    name: agent.name,
    label,
    invocationName: agent.name,
    description: agent.description ?? `Workspace-local CodeForge agent ${agent.name}.`,
    maxTurns: Math.max(1, Math.min(12, agent.maxTurns ?? 6)),
    allowedToolNames: localAgentAllowedToolNames(agent),
    local: true,
    systemPrompt: [
      `You are the workspace-local CodeForge agent "${label}" running inside VS Code.`,
      "Use only the configured OpenAI API-compatible endpoint and CodeForge-provided workspace tools.",
      `Agent definition file: ${agent.path}`,
      agent.description ? `Agent description: ${agent.description}` : undefined,
      "Follow the agent instructions exactly unless they conflict with CodeForge safety, workspace permission policy, or the user's latest request.",
      "Use the workspace tools you are allowed to use. Any edit, command, or MCP side effect is routed through the parent VS Code approval and permission policy.",
      "Do not use network resources outside explicitly configured endpoints.",
      "Agent instructions:",
      agent.body,
      "When reporting, include these plain labels when they fit: Scope, Result, Key files, Files changed, Issues, Confidence."
    ].filter((line): line is string => Boolean(line)).join("\n")
  };
}

function localAgentAllowedToolNames(agent: LocalAgent): readonly WorkerDefinition["allowedToolNames"][number][] {
  const requested = agent.tools.length > 0 ? agent.tools : ["read"];
  const allowed = new Set<string>();
  const knownToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  for (const rawTool of requested) {
    const tool = rawTool.toLowerCase();
    if (tool === "read" || tool === "readonly" || tool === "read-only") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
    } else if (tool === "code" || tool === "lsp" || tool === "symbols") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
    } else if (tool === "state" || tool === "task" || tool === "tasks" || tool === "todo" || tool === "todos") {
      addTools(allowed, localAgentStateTools);
    } else if (tool === "ask" || tool === "question" || tool === "questions") {
      addTools(allowed, localAgentQuestionTools);
    } else if (tool === "edit" || tool === "write" || tool === "files") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentStateTools);
      addTools(allowed, localAgentQuestionTools);
      addTools(allowed, localAgentEditTools);
      addTools(allowed, localAgentNotebookEditTools);
    } else if (tool === "notebook" || tool === "notebooks") {
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentNotebookEditTools);
    } else if (tool === "command" || tool === "shell" || tool === "bash" || tool === "terminal") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCommandTools);
    } else if (tool === "mcp" || tool === "service") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentMcpTools);
    } else if (tool === "agent" || tool === "agents" || tool === "delegate") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentAutomationTools);
    } else if (tool === "memory" || tool === "remember") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentMemoryTools);
    } else if (tool === "skill" || tool === "skills") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentSkillTools);
    } else if (tool === "all") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentStateTools);
      addTools(allowed, localAgentQuestionTools);
      addTools(allowed, localAgentEditTools);
      addTools(allowed, localAgentNotebookEditTools);
      addTools(allowed, localAgentCommandTools);
      addTools(allowed, localAgentMcpTools);
      addTools(allowed, localAgentAutomationTools);
      addTools(allowed, localAgentMemoryTools);
      addTools(allowed, localAgentSkillTools);
    } else if (knownToolNames.has(tool)) {
      allowed.add(tool);
    }
  }
  if (allowed.size === 0) {
    addTools(allowed, localAgentReadTools);
    addTools(allowed, localAgentCodeIntelTools);
    addTools(allowed, localAgentNotebookReadTools);
  }
  return [...allowed];
}

function addTools(target: Set<string>, tools: readonly string[]): void {
  for (const tool of tools) {
    target.add(tool);
  }
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

function toolError(message: string): string {
  return `<tool_use_error>Error: ${message}</tool_use_error>`;
}

function isToolErrorText(text: string): boolean {
  return text.includes("<tool_use_error>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    case "mcpResource":
      return "MCP resource";
    case "selection":
      return "Active selection";
    case "openFile":
      return "Open file";
    case "fileTree":
      return "Repo file list";
    case "file":
      return "Repo file";
    case "workspaceIndex":
      return "Repo index";
  }
}

function reviewCommandPrompt(scope: string): string {
  return [
    "You are an expert code reviewer working inside VS Code.",
    `Review: ${scope}`,
    "",
    "Use repo read/search/diagnostic tools when evidence is not already available.",
    "Do not edit files, create files, run terminal commands, or launch workers unless the user explicitly asks for implementation or verification.",
    "Prioritize correctness bugs, regressions, unsafe assumptions, missing tests, and behavior that conflicts with the user request.",
    "Lead with findings. Include concrete file paths and line references when available. If there are no concrete findings, say that clearly and list any remaining test gaps."
  ].join("\n");
}

function permissionModeFromSlashCommand(command: string): PermissionMode | undefined {
  switch (command) {
    case "/manual":
    case "/read-only":
    case "/readonly":
      return "manual";
    case "/smart":
    case "/default":
    case "/accept-edits":
    case "/acceptedits":
      return "smart";
    case "/full-auto":
    case "/fullauto":
    case "/workspace-trusted":
    case "/workspacetrusted":
      return "fullAuto";
    default:
      return undefined;
  }
}

function agentModeLabel(mode: AgentMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    default:
      return "Agent";
  }
}

function toolDefinitionsForAgentMode(mode: AgentMode): typeof toolDefinitions {
  if (mode === "agent") {
    return toolDefinitions;
  }
  return toolDefinitions.filter((tool) => readOnlyToolNames.has(tool.name));
}

function mcpFunctionName(serverId: string, toolName: string, usedNames: ReadonlySet<string>): string {
  const server = safeToolNameSegment(serverId).slice(0, 18) || "server";
  const tool = safeToolNameSegment(toolName).slice(0, 36) || "tool";
  const base = `mcp__${server}__${tool}`.slice(0, 64);
  if (!usedNames.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index++) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, 55)}_${Date.now().toString(36).slice(-8)}`;
}

function safeToolNameSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function mcpToolParameters(inputSchema: unknown): Record<string, unknown> {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema;
  }
  return {
    type: "object",
    additionalProperties: true
  };
}

function discoveredCodeForgeToolNames(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(new RegExp(`${escapeRegExp(codeForgeToolSchemaMarker)}\\s*([a-zA-Z0-9_]+)`, "g"))) {
      names.add(match[1]);
    }
  }
  return names;
}

function discoveredMcpToolNames(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(new RegExp(`${escapeRegExp(mcpToolSchemaMarker)}\\s*([a-zA-Z0-9_]+)`, "g"))) {
      names.add(match[1]);
    }
  }
  return names;
}

function searchCodeForgeTools(query: string, allowedToolNames: ReadonlySet<string>): readonly ToolSchemaSearchResult[] {
  const selected = selectedToolNames(query);
  return codeForgeTools
    .filter((tool) => allowedToolNames.has(tool.name))
    .map((tool): ToolSchemaSearchResult => ({
      name: tool.name,
      score: scoreToolSearch(query, selected, tool.name, tool.description, [tool.searchHint ?? "", tool.risk, tool.requiresApproval ? "approval" : "auto"]),
      content: formatCodeForgeToolSchemaSearchResult(tool)
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function selectedToolNames(query: string): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const match of query.matchAll(/select:([a-zA-Z0-9_,\-\s]+)/g)) {
    for (const name of match[1].split(/[,\s]+/)) {
      const normalized = name.trim();
      if (normalized) {
        selected.add(normalized);
      }
    }
  }
  return selected;
}

function scoreToolSearch(query: string, selected: ReadonlySet<string>, name: string, description: string | undefined, tags: readonly string[]): number {
  if (selected.size > 0) {
    return selected.has(name) ? 1000 : 0;
  }

  const normalizedQuery = query.toLowerCase().replace(/select:[^\s]+/g, " ");
  const terms = normalizedQuery.split(/[^a-z0-9_/-]+/).map((term) => term.trim()).filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return 0;
  }

  const haystack = [name, description ?? "", ...tags].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.toLowerCase() === term) {
      score += 80;
    } else if (name.toLowerCase().includes(term)) {
      score += 45;
    } else if (haystack.includes(term)) {
      score += 15;
    }
  }
  return score;
}

function formatCodeForgeToolSchemaSearchResult(tool: (typeof codeForgeTools)[number]): string {
  return [
    `${codeForgeToolSchemaMarker} ${tool.name}`,
    `Name: ${tool.name}`,
    `Risk: ${tool.risk}`,
    `Approval: ${tool.requiresApproval ? "required when policy asks" : "not required"}`,
    `Concurrency: ${tool.concurrencySafe ? "safe" : "serial"}`,
    tool.searchHint ? `Search hint: ${tool.searchHint}` : undefined,
    `Description: ${tool.description}`,
    "Schema:",
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }, null, 2)
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatMcpToolSchemaSearchResult(functionName: string, serverId: string, tool: McpToolSummary): string {
  return [
    `${mcpToolSchemaMarker} ${functionName}`,
    `Name: ${functionName}`,
    `Server: ${serverId}`,
    `MCP tool: ${tool.name}`,
    tool.description ? `Description: ${tool.description}` : undefined,
    "Schema:",
    JSON.stringify({
      name: functionName,
      description: `Call MCP tool ${tool.name} on configured server ${serverId}. ${tool.description ?? ""}`.trim(),
      parameters: mcpToolParameters(tool.inputSchema)
    }, null, 2)
  ].filter((line): line is string => line !== undefined).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentModeInstructions(mode: AgentMode): string {
  if (mode === "agent") {
    return [
      "Agent mode: Agent.",
      "Act as an autonomous coding agent inside the user's repo.",
      "You may explore multiple files, make coordinated edits, create files, run approved terminal commands, iterate on errors, and complete multi-step engineering workflows."
    ].join("\n");
  }
  if (mode === "ask") {
    return [
      "Agent mode: Ask.",
      "Act like a codebase-aware assistant inside VS Code for quick answers, explanations, debugging help, reviews, and code snippets.",
      "Use read-only workspace tools when codebase evidence is needed and the relevant file content is not already attached.",
      "Read-only multi-step inspection is allowed in Ask mode.",
      "Do not edit files, create files, run terminal commands, or execute side-effecting autonomous implementation workflows in Ask mode.",
      "If the user asks you to implement changes, explain the approach and tell them to switch to Agent mode before applying edits."
    ].join("\n");
  }
  return [
    "Agent mode: Plan.",
    "Analyze the codebase and reason through larger work before implementation.",
    "Use read-only workspace tools to inspect relevant files, identify existing patterns, break the task into steps, and call out risks or dependencies.",
    "Do not edit files, create files, propose patches, open diffs, or run terminal commands in Plan mode.",
    "When the plan is ready, present the intended edits clearly and tell the user to switch to Agent mode before implementation."
  ].join("\n");
}

const readOnlyToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "ask_user_question",
  "tool_list",
  "task_list",
  "task_get",
  "code_hover",
  "code_definition",
  "code_references",
  "code_symbols",
  "mcp_list_resources",
  "mcp_read_resource",
  "notebook_read"
]);

const maxBackgroundReviewIterations = 6;
const maxCuratorIterations = 24;

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface ReviewToolOutcome {
  readonly output: string;
  readonly summary: string;
  readonly notice: string;
}

function reviewWriteSucceeded(output: string): boolean {
  try {
    return Boolean((JSON.parse(output) as { success?: boolean }).success);
  } catch {
    return false;
  }
}

function describeMemoryWrite(args: Record<string, unknown>): string {
  const action = String(args.action ?? "update");
  const target = args.target === "user" ? "user profile" : "memory";
  const verb = action === "add" ? "saved to" : action === "remove" ? "removed from" : "updated";
  return `${verb} ${target}`;
}

// Hermes-style, user-facing notification shown live in the chat each time the autonomous
// self-improvement review writes to memory, the user profile (user.md), or a skill — so the user can
// see the system is actively learning. Returns "" for read-only review tools.
function learningNotice(name: string, args: Record<string, unknown>): string {
  if (name === "memory") {
    const action = String(args.action ?? "update");
    const isUser = args.target === "user";
    const snippet = noticeSnippet(args.content);
    if (action === "remove") {
      return isUser ? "👤 Updated your user profile — removed an outdated note" : "🧠 Pruned a memory it no longer needs";
    }
    const verb = action === "add" ? "Learned" : "Refined";
    if (isUser) {
      return `👤 ${verb} something about you${snippet ? `: “${snippet}”` : ""}`;
    }
    return `🧠 ${verb} a lesson from this session${snippet ? `: “${snippet}”` : ""}`;
  }
  if (name === "skill_manage") {
    const action = String(args.action ?? "update");
    const skill = String(args.name ?? "").trim();
    const named = skill ? ` “${skill}”` : "";
    if (action === "create") {
      return `🛠️ Created a new skill${named}`;
    }
    if (action === "delete" || action === "remove_file") {
      return `🗑️ Retired the skill${named}`;
    }
    return `🛠️ Improved the skill${named}`;
  }
  return "";
}

function noticeSnippet(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function summarizeReviewActions(actions: readonly string[]): string {
  return [...new Set(actions.filter(Boolean))].join(" · ");
}

// Recover memory/skill tool calls from a non-native model's text (the CodeForge JSON action protocol).
function reviewActionsFromText(content: string): { readonly name: string; readonly args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const action of parseActionsFromAssistantText(content)) {
    if (action.type === "memory") {
      out.push({ name: "memory", args: { action: action.action, target: action.target, content: action.content, old_text: action.oldText } });
    } else if (action.type === "skill_manage") {
      out.push({
        name: "skill_manage",
        args: {
          action: action.action,
          name: action.name,
          content: action.content,
          old_string: action.oldString,
          new_string: action.newString,
          replace_all: action.replaceAll,
          file_path: action.filePath,
          file_content: action.fileContent,
          absorbed_into: action.absorbedInto
        }
      });
    } else if (action.type === "skill_view") {
      out.push({ name: "skill_view", args: { name: action.name, file_path: action.filePath } });
    } else if (action.type === "skills_list") {
      out.push({ name: "skills_list", args: {} });
    }
  }
  return out;
}

function isInternalAutomationAction(action: AgentAction): boolean {
  return action.type === "spawn_agent" || action.type === "worker_output";
}

function isInternalStateAction(action: AgentAction): boolean {
  return action.type === "task_create" || action.type === "task_update";
}

function isInternalReadAction(action: AgentAction): boolean {
  return action.type === "tool_list"
    || action.type === "tool_search"
    || action.type === "task_list"
    || action.type === "task_get"
    || action.type === "code_hover"
    || action.type === "code_definition"
    || action.type === "code_references"
    || action.type === "code_symbols"
    || action.type === "mcp_list_resources"
    || action.type === "mcp_read_resource"
    || action.type === "notebook_read"
    || action.type === "skill_view"
    || action.type === "skills_list"
    || action.type === "fact_store"
    || action.type === "fact_feedback";
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
    case "spawn_agent":
      return `Launched agent ${action.agent || "implement"}.`;
    case "worker_output":
      return `Read worker output ${action.workerId}.`;
    case "ask_user_question":
      return "Answered question.";
    case "tool_list":
      return "Listed tools.";
    case "tool_search":
      return `Loaded tool schemas for ${action.query}.`;
    case "task_create":
      return "Created task.";
    case "task_update":
      return `Updated task ${action.taskId}.`;
    case "task_list":
      return "Listed tasks.";
    case "task_get":
      return `Read task ${action.taskId}.`;
    case "code_hover":
      return `Read hover at ${action.path}:${action.line}:${action.character}.`;
    case "code_definition":
      return `Found definitions at ${action.path}:${action.line}:${action.character}.`;
    case "code_references":
      return `Found references at ${action.path}:${action.line}:${action.character}.`;
    case "code_symbols":
      return "Listed code symbols.";
    case "mcp_list_resources":
      return "Listed MCP resources.";
    case "mcp_read_resource":
      return `Read MCP resource ${action.serverId}:${action.uri}.`;
    case "notebook_read":
      return `Read notebook ${action.path}.`;
    case "notebook_edit_cell":
      return `Edited notebook ${action.path} cell ${action.index}.`;
    case "memory":
      return "Updated curated memory.";
    case "fact_store":
      return `Durable memory: ${action.action}.`;
    case "fact_feedback":
      return "Rated a durable fact.";
    case "skill_manage":
      return `Skill ${action.action}: ${action.name}.`;
    case "skill_view":
      return `Viewed skill ${action.name}.`;
    case "skills_list":
      return "Listed skills.";
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
    case "mcp_call_tool":
      return `Called MCP ${action.serverId}/${action.toolName}.`;
  }
}

function approvalContinuationPrompt(action: AgentAction, outcome: "accepted" | "failed" | "rejected"): string {
  const summary = toolSummary(action);
  if (outcome === "accepted") {
    return `CodeForge continuation: The user approved ${summary}. Continue the original task from the existing plan. If more edits, commands, or tool calls are still needed, request the next one now. Do not stop until the user's task is complete.`;
  }
  if (outcome === "rejected") {
    return `CodeForge continuation: The user rejected ${summary}. Continue the original task by choosing an alternative allowed approach. Do not retry the same rejected action unchanged.`;
  }
  return `CodeForge continuation: ${summary} was approved but failed. Continue the original task by inspecting the current state and trying a corrected approach. Do not repeat the same failed action unchanged.`;
}

function modelStreamIdleTimeoutMs(configuredSeconds: number): number {
  const configured = Number(process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(10, Math.floor(configured));
  }
  if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
    return Math.max(30_000, Math.floor(configuredSeconds * 1000));
  }
  return defaultModelStreamIdleTimeoutMs;
}

function invocationForApproval(approval: ApprovalRequest): ToolInvocation {
  return {
    id: approval.toolCallId ?? approval.id,
    action: approval.action,
    source: approval.toolCallId ? "native" : "json",
    toolCallId: approval.toolCallId
  };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

function isRecoverableEditPreflightError(error: unknown): boolean {
  if (isRecord(error) && error.modelRecoverableToolError === true) {
    return true;
  }
  const message = errorMessage(error);
  return /edit_file oldText (?:was not found|appears \d+ times)/.test(message)
    || /requires reading .* before modifying an existing file/.test(message)
    || /requires reading .* before modifying an existing notebook/.test(message)
    || /cannot modify .* because the file changed since it was read/.test(message);
}

function modelRecoverableToolError(message: string): Error & { readonly modelRecoverableToolError: true } {
  const error = new Error(message) as Error & { modelRecoverableToolError: true };
  Object.defineProperty(error, "modelRecoverableToolError", {
    value: true,
    enumerable: true
  });
  return error;
}

function readStateKey(path: string): string {
  return normalizeWorkspacePathInput(path).replace(/^\/+/, "").replace(/^\.\//, "");
}

function readFileContentFromToolResult(result: string, path: string): string {
  const prefix = `read_file ${path}\n\n`;
  return result.startsWith(prefix) ? result.slice(prefix.length) : result.replace(/^read_file[^\n]*\n\n/, "");
}

function isMissingFileError(message: string): boolean {
  return /(?:no such file|not found|does not exist|enoent|unable to resolve nonexistent)/i.test(message);
}

function summaryForInvocation(invocation: ToolInvocation): string {
  try {
    return toolSummary(invocation.action);
  } catch {
    return invocation.action.type;
  }
}
