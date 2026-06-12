import { EventEmitter } from "events";
import { parseActionsFromAssistantText, toolDefinitions } from "../core/actionProtocol";
import { ApprovalQueue } from "../core/approvals";
import { CodeIntelPort, UnavailableCodeIntelPort } from "../core/codeIntel";
import { GitPort, UnavailableGitPort } from "../core/git";
import { runGitOperation, unsafeGitArgsMessage } from "./gitTool";
import { LearningCoordinator } from "./learningCoordinator";
import { ModelResolver } from "./modelResolver";
import { DoctorService } from "./doctorService";
import { McpCoordinator } from "./mcpCoordinator";
import { SessionService } from "./sessionService";
import { ContextManager } from "./contextManager";
import { ChangeVerifier } from "./changeVerifier";
import { InspectorLog } from "./inspectorLog";
import { MemoryCommandsService } from "./memoryCommands";
import { PinnedFiles } from "./pinnedFiles";
import { ProviderGateway } from "./providerGateway";
import { agentModeLabel, SystemPromptBuilder } from "./systemPrompt";
import { TaskBoard } from "./taskBoard";
import { UndoManager } from "./undoManager";
import { approvalAcceptedText, approvalContinuationPrompt, approvalPermissionDecision, formatQuestionAnswers, invocationForApproval } from "./approvalText";
import { SlashCommandRouter } from "./slashCommandRouter";
// Re-exported so existing test imports (`from agentController`) keep working after the extraction.
export { resolveConfiguredModelId } from "./modelResolver";
import { errorMessage, firstLines, isContextOverflowError, isMissingFileError, isRecoverableEditPreflightError, isToolErrorText, modelRecoverableToolError, toolError } from "./toolText";
// Re-exported so existing test imports (`from agentController`) keep working after the extraction.
export { isContextOverflowError } from "./toolText";
import { modelStreamIdleTimeoutMs, streamWithIdleTimeout } from "./modelStream";
// Re-exported so existing test imports (`from agentController`) keep working after the extraction.
export { buildGitArgv } from "./gitTool";
import { ContextBuilder, contextItemKindLabel } from "../core/contextBuilder";
import { ContextUsage, formatBytes } from "../core/contextUsage";
import { DoctorCheck, formatDoctorReport, worstDoctorStatus } from "../core/doctor";
import { EndpointCapabilityStore } from "../core/endpointCapabilityCache";
import {
  loadLocalCommands,
  loadLocalAgents,
  loadLocalHooks,
  loadLocalSkills,
  loadLocalSoul,
  LocalAgent,
  LocalHook,
  localHookMatches
} from "../core/localExtensions";
import { executeLocalReadOnlyTools, LocalToolProgress } from "../core/localToolExecutor";
import { formatSkillsDigest } from "../core/skills";
import { MemoryStore } from "../core/memory";
import { MemoryManager } from "./memoryManager";
import { MemoryProvider } from "../core/memoryProvider";
import { BuiltinMemoryProvider } from "../core/builtinMemoryProvider";
import { memoryStoreNoteStore } from "../core/memoryStoreNoteStore";
import { SkillIo } from "../core/skillIo";
import { SkillManager } from "../core/skillManager";
import { SkillUsageTracker } from "../core/skillUsage";
import { NotebookPort, UnavailableNotebookPort } from "../core/notebooks";
import {
  callConfiguredMcpTool,
  inspectConfiguredMcpServers,
  readConfiguredMcpResource
} from "../core/mcpClient";
import { evaluateActionPermission, permissionModeLabel } from "../core/permissions";
import { SessionSnapshot, SessionStore } from "../core/session";
import { classifyShellCommand } from "../core/shellSemantics";
import { normalizeWorkspacePathInput } from "../core/workspacePaths";
import {
  AgentAction,
  AgentMode,
  ApprovalRequest,
  GitAction,
  ChatMessage,
  ContextItem,
  ContextLimits,
  LlmRequest,
  LlmProvider,
  LlmStreamEvent,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  WorkspacePort
} from "../core/types";
import { codeForgeTools, isApprovalAction, isConcurrencySafeAction, isInternalAutomationAction, isInternalReadAction, isInternalStateAction, isLocalReadOnlyAction, isReadOnlyAction, ToolInvocation, toolSummary, validateAction } from "../core/toolRegistry";
import { formatCommandResult, hookFailureStatus } from "./commandResultText";
import {
  discoveredCodeForgeToolNames,
  discoveredMcpToolNames,
  formatMcpToolSchemaSearchResult,
  mcpFunctionName,
  McpToolBinding,
  mcpToolParameters,
  parseNativeToolCall,
  scoreToolSearch,
  searchCodeForgeTools,
  selectedToolNames,
  ToolSchemaSearchResult,
  toolDefinitionsForAgentMode
} from "../core/toolDiscovery";
import { DiffService } from "../adapters/diffService";
import { TerminalRunner } from "../adapters/terminalRunner";
import { CodeForgeConfigService, CodeForgeSettingsUpdate } from "../adapters/vscodeConfig";
import { WorkerManager } from "./workerManager";
import { findWorkerDefinition, isWorkerKind } from "../core/workerAgents";
import { WorkerDefinition, WorkerSummary } from "../core/workerTypes";

// UI contract types live in ./agentUiTypes. Imported here for internal use and re-exported so existing
// consumers (the webview bridge, tests) can keep importing them from the controller.
export * from "./agentUiTypes";
import {
  AgentActiveContextSummary,
  AgentLocalCommandSummary,
  AgentModelSummary,
  AgentProfileSummary,
  AgentSessionSummary,
  AgentToolUse,
  AgentUiEvent,
  AgentUiState
} from "./agentUiTypes";

const maxAgentToolTurns = 25;
const maxReadOnlyToolTurns = 12;
const workerJoinTimeoutMs = 900_000;
const queuedWorkLimit = 20;

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
  private readonly gitPort: GitPort;
  private readonly sessionStore: SessionStore | undefined;
  private readonly memoryStore: MemoryStore | undefined;
  private readonly codeIntel: CodeIntelPort;
  private readonly notebooks: NotebookPort;
  private readonly workers: WorkerManager;
  private readonly events = new EventEmitter();
  private readonly approvals = new ApprovalQueue();
  private readonly workerApprovalWaiters = new Map<string, { readonly workerId: string; readonly resolve: (text: string) => void }>();
  private readonly approvalContinuations = new Map<string, readonly ToolInvocation[]>();
  // Owns provider construction + the per-(profile,model) capability probe/cache.
  private readonly providerGateway: ProviderGateway;
  // Owns endpoint discovery caches + which model is selected/served per profile, and the availability
  // warnings. The controller reads/writes the cache through accessors and delegates resolution.
  private readonly models: ModelResolver;
  private readonly doctor: DoctorService;
  private readonly mcp: McpCoordinator;
  private readonly context: ContextManager;
  // Owns the run-inspector + permission-audit ring buffers and their UI event.
  private readonly inspector: InspectorLog;
  // Owns the bounded pre-change snapshot stack and the /undo restore.
  private readonly undoManager: UndoManager;
  // Owns the raw curated-memory store (webview Memory panel commands + summary projection).
  private readonly memoryCommands: MemoryCommandsService;
  // Builds the system message from persona + curated memory + agent-mode instructions.
  private readonly systemPrompt: SystemPromptBuilder;
  // Post-edit diagnostics footer for changed files.
  private readonly changeVerifier: ChangeVerifier;
  private readonly readFileState = new Map<string, ReadFileSnapshot>();
  private readonly notebookReadState = new Set<string>();
  private messages: ChatMessage[] = [];
  // Owns the model-facing task board (task_create/update/list/get) + its session persistence/restore.
  private readonly taskBoard: TaskBoard;
  private lastContextItems: readonly ContextItem[] = [];
  // Owns the user-pinned context files (the /pin surface + the set read into every request).
  private readonly pinned: PinnedFiles;
  private lastTokenUsage: TokenUsage | undefined;
  private runningAbort: AbortController | undefined;
  private continueAfterCurrentRun = false;
  private pendingContinuation: PendingContinuation | undefined;
  private queuedWork: QueuedWork[] = [];
  private readonly sessions: SessionService;
  private soulText: string | undefined;
  private memoryManager: MemoryManager | undefined;
  private memoryInitialized = false;
  private skillManager: SkillManager | undefined;
  private skillUsage: SkillUsageTracker | undefined;
  private skillIo: SkillIo | undefined;
  // Owns the self-improvement review + curator. The controller keeps only the run-loop signals it
  // reads (turn/iteration counts, error flag) and the transcript.
  private readonly learning: LearningCoordinator;
  // Owns the entire /command surface (parsing, dispatch, report builders). Constructed last so it can
  // bind to every collaborator above.
  private readonly slash: SlashCommandRouter;
  // Did the most recent run surface an error? Read by the learning loop so it won't distil durable
  // lessons from a failed run.
  private lastRunErrored = false;
  // Cumulative cadence counters the learning loop reads to decide when a review is due.
  private userTurnCount = 0;
  private toolIterationCount = 0;

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
    externalMemoryProvider?: MemoryProvider,
    gitPort: GitPort = new UnavailableGitPort()
  ) {
    this.config = config;
    this.inspector = new InspectorLog({
      emit: (event) => this.emit(event)
    });
    this.undoManager = new UndoManager({
      readFileSnapshot: (path, maxBytes) => this.workspace.readTextFile(path, maxBytes, this.runningAbort?.signal),
      restoreFile: (path, previousContent) => this.diff.restoreFile(path, previousContent),
      forgetReadState: (path) => {
        this.readFileState.delete(path);
      },
      emit: (event) => this.emit(event),
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail),
      publishState: () => this.publishState(),
      isBusy: () => Boolean(this.runningAbort)
    });
    this.taskBoard = new TaskBoard({
      record: (factory) => this.sessions.record(factory),
      publishState: () => this.publishState()
    });
    this.memoryCommands = new MemoryCommandsService({
      memoryStore,
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail),
      emit: (event) => this.emit(event),
      publishState: () => this.publishState()
    });
    this.pinned = new PinnedFiles({
      workspace,
      emit: (event) => this.emit(event),
      publishState: () => this.publishState()
    });
    this.systemPrompt = new SystemPromptBuilder({
      getSoulText: () => this.soulText,
      getMemoryBlock: () => this.memoryManager?.buildSystemPrompt() ?? "",
      getAgentMode: () => this.config.getAgentMode()
    });
    this.changeVerifier = new ChangeVerifier({
      getDiagnostics: (path, limit, signal) => this.workspace.getDiagnostics(path, limit, signal),
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail),
      signal: () => this.runningAbort?.signal
    });
    this.models = new ModelResolver({
      config,
      emit: (event) => this.emit(event),
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail)
    });
    this.workspace = workspace;
    this.terminal = terminal;
    this.diff = diff;
    this.gitPort = gitPort;
    this.sessionStore = sessionStore;
    this.memoryStore = memoryStore;
    this.codeIntel = codeIntel;
    this.notebooks = notebooks;
    this.providerGateway = new ProviderGateway({
      config,
      providerFactory,
      endpointCapabilityStore,
      getInspection: (profileId) => this.models.getInspection(profileId),
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail)
    });
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
      mcpResources: () => this.mcp.getContextItems(),
      createProvider: () => this.providerGateway.createProvider(),
      resolveModel: (provider, signal) => this.models.resolveModel(provider, signal),
      capabilities: (provider, model, signal) => this.providerGateway.capabilities(provider, model, signal),
      selectedModelInfo: () => this.models.selectedModelInfo(),
      requestMaxTokens: () => this.requestMaxTokens(),
      permissionPolicy: () => this.config.getPermissionPolicy(),
      executeAction: (action, toolCallId, worker) => this.executeWorkerAction(action, toolCallId, worker),
      onReadFile: (path, content, maxBytes) => this.rememberReadFile(path, content, maxBytes, "worker"),
      record: (factory) => this.sessions.persist(factory),
      onDidChange: (workers) => this.emit({ type: "workers", workers }),
      onNotice: (message) => this.emit({ type: "message", role: "system", text: message })
    });
    this.learning = new LearningCoordinator({
      memoryManager: () => this.memoryManager,
      skillManager: () => this.skillManager,
      skillIo: () => this.skillIo,
      skillUsage: () => this.skillUsage,
      config: this.config,
      createProvider: () => this.providerGateway.createProvider(),
      resolveModel: (provider, signal) => this.models.resolveModel(provider, signal),
      resolveAuxiliaryModel: (provider, signal, fallback) => this.models.resolveAuxiliaryModel(provider, signal, fallback),
      capabilities: (provider, model, signal) => this.providerGateway.capabilities(provider, model, signal),
      streamChatWithIdleTimeout: (provider, request, abort, purpose) => this.streamChatWithIdleTimeout(provider, request, abort, purpose),
      requestMaxTokens: () => this.requestMaxTokens(),
      ensureMemoryInitialized: () => this.ensureMemoryInitialized(),
      publishState: () => this.publishState(),
      emit: (event) => this.emit(event),
      recordInspector: (level, category, summary, detail) => this.inspector.record(level, category, summary, detail),
      getMessages: () => this.messages,
      getUserTurnCount: () => this.userTurnCount,
      getToolIterationCount: () => this.toolIterationCount,
      getLastRunErrored: () => this.lastRunErrored
    });
    this.doctor = new DoctorService({
      config,
      workspace: this.workspace,
      createProvider: () => this.providerGateway.createProvider(),
      capabilities: (provider, model, signal) => this.providerGateway.capabilities(provider, model, signal),
      cacheInspection: (profileId, inspection) => this.models.cacheInspection(profileId, inspection),
      selectedModelFor: (profile, inspection) => this.models.selectedModelFor(profile, inspection),
      hasSessionStore: () => Boolean(this.sessionStore),
      hasMemoryStore: () => Boolean(this.memoryStore)
    });
    this.mcp = new McpCoordinator({
      config,
      emit: (event) => this.emit(event),
      publishState: () => this.publishState(),
      emitContextUsage: () => this.emitContextUsage(),
      currentSignal: () => this.runningAbort?.signal
    });
    this.sessions = new SessionService({
      store: sessionStore,
      emit: (event) => this.emit(event)
    });
    this.context = new ContextManager({
      config,
      getMessages: () => this.messages,
      replaceMessages: (messages, reason, preserveContextItems) => this.replaceMessages(messages, reason, preserveContextItems),
      getLastContextItems: () => this.lastContextItems,
      getLastTokenUsage: () => this.lastTokenUsage,
      selectedModelInfo: () => this.models.selectedModelInfo(),
      resolveAuxiliaryModel: (provider, signal, fallback) => this.models.resolveAuxiliaryModel(provider, signal, fallback),
      streamChatWithIdleTimeout: (provider, request, abort, purpose) => this.streamChatWithIdleTimeout(provider, request, abort, purpose),
      systemMessage: () => this.systemPrompt.build(),
      approvalsCount: () => this.approvals.list().length,
      emit: (event) => this.emit(event),
      publishState: () => this.publishState(),
      publishTranscript: () => this.publishTranscript()
    });
    this.slash = new SlashCommandRouter({
      config,
      workspace: this.workspace,
      sessions: this.sessions,
      models: this.models,
      workers: this.workers,
      memoryStore: this.memoryStore,
      emit: (event) => this.emit(event),
      reset: () => this.reset(),
      cancel: () => this.cancel(),
      resumeSession: (sessionId) => this.resumeSession(sessionId),
      compactContext: (focus) => this.compactContext(focus),
      undo: () => this.undo(),
      runDoctor: () => this.runDoctor(),
      runPrompt: (visiblePrompt, modelPrompt) => this.runPrompt(visiblePrompt, modelPrompt),
      setAgentMode: (mode) => this.setAgentMode(mode),
      setPermissionMode: (mode) => this.setPermissionMode(mode),
      pinFile: (path) => this.pinFile(path),
      pinActiveFile: () => this.pinActiveFile(),
      unpinFile: (path) => this.unpinFile(path),
      currentContextUsage: () => this.currentContextUsage(),
      emitContextUsage: () => this.emitContextUsage(),
      selectModel: (model) => this.selectModel(model),
      refreshModels: () => this.refreshModels(),
      handleCuratorCommand: (rest) => this.learning.handleCuratorCommand(rest),
      handleMcpCommand: (rest) => this.mcp.handleCommand(rest),
      showWorkerOutput: (workerId) => this.showWorkerOutput(workerId),
      attachWorkerOutput: (workerId) => this.attachWorkerOutput(workerId),
      stopWorker: (workerId) => this.stopWorker(workerId),
      replaceMessages: (messages, reason, preserveContextItems) => this.replaceMessages(messages, reason, preserveContextItems),
      publishTranscript: () => this.publishTranscript(),
      publishState: () => this.publishState(),
      clearApprovals: () => {
        this.approvals.clear();
        this.workerApprovalWaiters.clear();
      },
      emitInspector: () => this.inspector.emit(),
      capabilitySummaries: (profileId) => this.providerGateway.capabilitySummaries(profileId),
      getMessages: () => this.messages,
      getLastContextItems: () => this.lastContextItems,
      getPinnedFiles: () => this.pinned.list(),
      getInspectorEntries: () => this.inspector.inspectorLog(),
      getAuditEntries: () => this.inspector.auditLog(),
      currentSignal: () => this.runningAbort?.signal
    });
  }

  // Public delegate kept for the live curator smoke test and any external caller.
  async runCurator(options: { readonly dryRun?: boolean } = {}): Promise<string> {
    return this.learning.runCurator(options);
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
        this.taskBoard.reset();
        this.lastContextItems = [];
        this.mcp.reset();
        this.pinned.clear();
        this.readFileState.clear();
        this.notebookReadState.clear();
        this.inspector.reset();
        this.lastTokenUsage = undefined;
        this.sessions.clearSession();
        this.memoryInitialized = false;
        this.workers.clear();
        this.approvals.clear();
        this.workerApprovalWaiters.clear();
      }
      this.continueAfterCurrentRun = false;
      this.pendingContinuation = undefined;
      this.emit({ type: "sessionReset" });
      this.inspector.emit();
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
    return this.sessions.listSummaries(limit);
  }

  getCurrentSessionId(): string | undefined {
    return this.sessions.currentSessionId();
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
    if (this.runningAbort && this.sessions.currentSessionId() === sessionId) {
      this.emit({ type: "error", text: "Stop the current CodeForge request before deleting the active conversation." });
      return false;
    }

    const deleted = await this.sessionStore.deleteSession(sessionId);
    if (!deleted) {
      this.emit({ type: "error", text: `No saved CodeForge session found for ${sessionId}.` });
      return false;
    }

    if (this.sessions.currentSessionId() === sessionId) {
      this.reset();
    } else {
      await this.publishState();
    }
    this.emit({ type: "status", text: `Deleted conversation ${sessionId}.` });
    return true;
  }

  async refreshModels(): Promise<void> {
    try {
      const provider = await this.providerGateway.createProvider();
      const inspection = await provider.inspectEndpoint();
      this.models.cacheInspection(provider.profile.id, inspection);
      const models = inspection.models.map((model) => model.id);
      const selectedModel = this.models.selectedModelFor(provider.profile, inspection);
      // Seed the per-profile selection from the resolved id (canonical when matched, configured id
      // when not) so that every later selectedModelFor/resolveModel call short-circuits to the same
      // value the dropdown is showing — no dropdown toggle required to make display and request agree.
      this.models.seedSelectedModel(provider.profile.id, selectedModel);
      this.models.notifyIfSelectedModelUnavailable(provider.profile, inspection);
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
    this.runningAbort = abort;
    this.emit({ type: "status", text: "Running CodeForge Doctor." });

    let checks: DoctorCheck[];
    try {
      checks = await this.doctor.buildChecks(abort.signal);
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

  async selectProfile(profileId: string): Promise<void> {
    await this.config.setActiveProfile(profileId);
    this.lastTokenUsage = undefined;
    await this.refreshModels();
  }

  async selectModel(model: string): Promise<void> {
    const profileId = this.config.getActiveProfileId();
    this.models.setSelectedModel(profileId, model);
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

  // Public /pin facade — view provider + slash router call these by name; logic lives in PinnedFiles.
  async pinActiveFile(): Promise<void> {
    await this.pinned.pinActive();
  }

  async pinFile(path: string): Promise<void> {
    await this.pinned.pin(path);
  }

  async unpinFile(path?: string): Promise<void> {
    await this.pinned.unpin(path);
  }

  // Public memory-panel facade — the view provider and tests call these by name; logic lives in
  // MemoryCommandsService.
  async addMemory(text: string, scope: "workspace" | "user" | "agent" = "workspace", namespace?: string): Promise<void> {
    await this.memoryCommands.add(text, scope, namespace);
  }

  async updateMemory(id: string, text: string, scope: "workspace" | "user" | "agent" = "workspace", namespace?: string): Promise<void> {
    await this.memoryCommands.update(id, text, scope, namespace);
  }

  async removeMemory(id: string): Promise<void> {
    await this.memoryCommands.remove(id);
  }

  async clearMemories(): Promise<void> {
    await this.memoryCommands.clear();
  }

  async updateSettings(settings: Partial<CodeForgeSettingsUpdate>): Promise<void> {
    await this.config.updateSettings(settings);
    this.lastTokenUsage = undefined;
    this.emit({ type: "status", text: "Settings saved." });
    await this.refreshModels();
  }

  // Public MCP surface (called from the webview bridge) — delegated to the MCP coordinator.
  async inspectMcpServers(serverId?: string, servers = this.config.getMcpServers()): Promise<void> {
    await this.mcp.inspectServers(serverId, servers);
  }

  async attachMcpResource(serverId: string, uri: string, servers = this.config.getMcpServers()): Promise<void> {
    await this.mcp.attachResource(serverId, uri, servers);
  }

  detachMcpResource(serverId: string, uri: string): void {
    this.mcp.detachResource(serverId, uri);
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
      const provider = await this.providerGateway.createProvider();
      const model = this.config.getAuxiliaryModel()
        ? await this.models.resolveAuxiliaryModel(provider, abort.signal)
        : await this.models.resolveModel(provider, abort.signal);
      await this.context.compact(provider, model, abort, focus);
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

  private streamChatWithIdleTimeout(
    provider: LlmProvider,
    request: LlmRequest,
    abort: AbortController,
    purpose: string
  ): AsyncIterable<LlmStreamEvent> {
    return streamWithIdleTimeout(provider, request, abort, purpose, {
      idleTimeoutMs: modelStreamIdleTimeoutMs(this.config.getModelIdleTimeoutSeconds()),
      onStatus: (text) => this.emit({ type: "status", text })
    });
  }

  reset(): void {
    this.runningAbort?.abort();
    this.runningAbort = undefined;
    this.messages = [];
    this.taskBoard.reset();
    this.lastContextItems = [];
    this.mcp.reset();
    this.pinned.clear();
    this.readFileState.clear();
    this.notebookReadState.clear();
    this.inspector.reset();
    this.lastTokenUsage = undefined;
    this.sessions.clearSession();
    this.workers.clear();
    this.approvals.clear();
    this.workerApprovalWaiters.clear();
    this.approvalContinuations.clear();
    this.continueAfterCurrentRun = false;
    this.pendingContinuation = undefined;
    this.queuedWork = [];
    this.undoManager.reset();
    this.memoryInitialized = false;
    this.userTurnCount = 0;
    this.toolIterationCount = 0;
    this.learning.reset();
    this.emit({ type: "sessionReset" });
    this.inspector.emit();
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
      await this.slash.handle(prompt);
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
    this.inspector.record("info", "run", `Started ${agentModeLabel(this.config.getAgentMode())} request.`, visiblePrompt);
    this.emit({ type: "message", role: "user", text: visiblePrompt });
    this.userTurnCount += 1;
    this.lastRunErrored = false;

    try {
      const provider = await this.providerGateway.createProvider();
      const model = await this.models.resolveModel(provider, abort.signal);
      await this.context.autoCompactIfNeeded(provider, model, abort, "before request");
      const context = new ContextBuilder(this.workspace, this.effectiveContextLimits(), { mcpResources: this.mcp.getContextItems(), pinnedFiles: this.pinned.list() });
      const contextItems = await context.build(abort.signal);
      const contextText = context.format(contextItems);
      this.lastContextItems = contextItems;
      this.inspector.record("info", "context", `Attached ${contextItems.length} context item(s).`, contextItems.map((item) => `${contextItemKindLabel(item.kind)}: ${item.label}`).join("\n"));
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

      await this.runModelLoopWithOverflowRecovery(provider, model, abort);
      await this.context.autoCompactIfNeeded(provider, model, abort, "after request");
    } catch (error) {
      this.lastRunErrored = true;
      this.inspector.record("error", "run", "Request failed.", errorMessage(error));
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
    this.inspector.recordAudit(approval.action, approvalPermissionDecision(approval), "accepted");
    this.inspector.record("info", "approval", `Approved ${approval.action.type}.`, approval.summary);
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
      this.inspector.recordAudit(approval.action, approvalPermissionDecision(approval), "failed");
      this.inspector.record("error", "approval", `Approved ${approval.action.type} failed.`, message);
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
      this.inspector.recordAudit(approval.action, approvalPermissionDecision(approval), "rejected");
      this.inspector.record("warn", "approval", `Rejected ${approval.action.type}.`, approval.summary);
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

  // Run the agent turn, recovering once from a context-window overflow. Local models frequently
  // report a larger window in /v1/models than they actually accept, so a prompt that "fit" can still
  // be rejected. Rather than failing the turn, compact older context once and retry.
  private async runModelLoopWithOverflowRecovery(provider: LlmProvider, model: string, abort: AbortController): Promise<void> {
    try {
      await this.runModelLoop(provider, model, abort);
    } catch (error) {
      if (abort.signal.aborted || !isContextOverflowError(error)) {
        throw error;
      }
      this.inspector.record("warn", "context", "Model context window exceeded — compacting and retrying.", errorMessage(error));
      this.emit({ type: "status", text: "Context window exceeded — compacting and retrying." });
      this.emit({
        type: "message",
        role: "system",
        text: "⚠️ The request exceeded the model's context window. CodeForge compacted older context and retried automatically."
      });
      const compactModel = this.config.getAuxiliaryModel()
        ? await this.models.resolveAuxiliaryModel(provider, abort.signal, model)
        : model;
      await this.context.compact(provider, compactModel, abort, "Recover from a context-window overflow.");
      await this.publishTranscript();
      // Single retry — a second overflow propagates to the caller as a normal error.
      await this.runModelLoop(provider, model, abort);
    }
  }

  private async runModelLoop(provider: LlmProvider, model: string, abort: AbortController): Promise<void> {
    const maxToolTurns = this.config.getAgentMode() === "agent" ? maxAgentToolTurns : maxReadOnlyToolTurns;
    const maxInvalidRetries = this.config.getMaxInvalidToolCallRetries();
    let consecutiveInvalidIterations = 0;
    for (let iteration = 0; iteration < maxToolTurns; iteration++) {
      this.context.compactOldToolResults();
      this.emit({ type: "status", text: `Calling ${provider.profile.label} / ${model}` });
      const capabilities = await this.providerGateway.capabilities(provider, model, abort.signal);
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
        } else if (event.type === "reasoning") {
          // Display-only thinking stream — surfaced to the user but never appended to assistantText,
          // so it is not echoed back into the model transcript on the next turn.
          this.emit({ type: "assistantReasoningDelta", text: event.text });
        } else if (event.type === "toolCalls") {
          for (const toolCall of event.toolCalls) {
            nativeToolCalls.push(toolCall);
            const parsed = parseNativeToolCall(toolCall, mcpToolBindings);
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
            this.inspector.record("error", "run", stopMessage, "Raise codeforge.agent.maxInvalidToolCallRetries if your model needs more retries, or check the model's tool-call format.");
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
          this.inspector.recordAudit(invocation.action, { behavior: "deny", source: "default", reason }, "denied");
          this.appendDeniedOrInvalidToolResult(invocation, reason);
          continuedWithLocalContext = true;
          index++;
          continue;
        }

        const decision = evaluateActionPermission(invocation.action, permissionPolicy);
        if (decision.behavior === "deny") {
          this.inspector.recordAudit(invocation.action, decision, "denied");
          this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
          continuedWithLocalContext = true;
          index++;
          continue;
        }
        if (decision.behavior === "ask") {
          this.inspector.recordAudit(invocation.action, decision, "approval");
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

        this.inspector.recordAudit(invocation.action, decision, "allowed");
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
        this.inspector.recordAudit(invocation.action, { behavior: "deny", source: "default", reason }, "denied");
        this.appendDeniedOrInvalidToolResult(invocation, reason);
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      const decision = evaluateActionPermission(invocation.action, permissionPolicy);
      if (decision.behavior === "deny") {
        this.inspector.recordAudit(invocation.action, decision, "denied");
        this.appendDeniedOrInvalidToolResult(invocation, decision.reason);
        continuedWithLocalContext = true;
        index++;
        continue;
      }

      if (decision.behavior === "ask") {
        this.inspector.recordAudit(invocation.action, decision, "approval");
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

      this.inspector.recordAudit(invocation.action, decision, "allowed");
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
    this.inspector.record("info", "tool", `Running ${action.type}.`, toolSummary(action));
    try {
      const result = await this.executePermittedAction(action, toolCallId);
      this.inspector.record(isToolErrorText(result) ? "warn" : "info", "tool", `Finished ${action.type}.`, firstLines(result, 8));
      return result;
    } catch (error) {
      const content = toolError(errorMessage(error));
      this.inspector.record("error", "tool", `${action.type} failed.`, errorMessage(error));
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
      this.inspector.record("warn", "approval", `Preview failed for ${action.type}.`, previewError);
      approvalMetadata = {
        ...approvalMetadata,
        detail: [approvalMetadata.detail, previewError].filter((item): item is string => Boolean(item)).join("\n\n")
      };
    }
    const approval = this.approvals.createForAction(action, decision, toolCallId, approvalMetadata);
    await this.recordApprovalRequested(approval);
    this.inspector.record("warn", "approval", `Approval requested for ${action.type}.`, decision.reason);
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
      this.inspector.recordAudit(invocation.action, decision, "failed");
      this.inspector.record("warn", "approval", `${invocation.action.type} failed preflight.`, firstLines(message, 12));
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
      this.inspector.recordAudit(action, decision, "denied");
      return toolError(`${action.type} was denied by the parent permission policy. ${decision.reason}`);
    }

    if (decision.behavior === "ask") {
      this.inspector.recordAudit(action, decision, "approval");
      let approval: ApprovalRequest;
      try {
        approval = await this.requestApproval(action, toolCallId, decision, this.workerApprovalMetadata(worker, action, decision));
      } catch (error) {
        if (!isRecoverableEditPreflightError(error)) {
          throw error;
        }
        this.inspector.recordAudit(action, decision, "failed");
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

    this.inspector.recordAudit(action, decision, "allowed");
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

  private async executeGitAction(action: GitAction): Promise<string> {
    const result = await runGitOperation(this.gitPort, action, this.runningAbort?.signal);
    return result ?? toolError(unsafeGitArgsMessage(action));
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

    if (action.type === "git") {
      transcriptResult = await this.executeGitAction(action);
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
      transcriptResult = await this.taskBoard.createTask(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_update") {
      transcriptResult = await this.taskBoard.updateTask(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_list") {
      transcriptResult = this.taskBoard.listTasks(action);
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "task_get") {
      transcriptResult = this.taskBoard.getTask(action.taskId);
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
      transcriptResult = await this.mcp.listResourcesForTool(action.serverId);
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
        { markAgentCreated: this.learning.isInBackgroundReview() }
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
      transcriptResult = `propose_patch\n\nApplied changes to ${changed.join(", ")}.${await this.changeVerifier.verify(changed)}`;
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "write_file") {
      await this.preflightWritableAction(action);
      await this.recordCheckpoint(action, `Before writing ${action.path}.`);
      const changed = await this.diff.applyWriteFile(action);
      transcriptResult = `write_file ${action.path}\n\nWrote ${changed.join(", ")}.${await this.changeVerifier.verify(changed)}`;
      this.rememberReadFile(action.path, action.content, Math.max(48000, Buffer.byteLength(action.content, "utf8")), "tool");
      await this.runLocalHooks("postTool", action);
      return transcriptResult;
    }

    if (action.type === "edit_file") {
      await this.preflightWritableAction(action);
      await this.recordCheckpoint(action, `Before editing ${action.path}.`);
      const changed = await this.diff.applyEditFile(action);
      transcriptResult = `edit_file ${action.path}\n\nEdited ${changed.join(", ")}.${await this.changeVerifier.verify(changed)}`;
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
      transcriptResult = `${transcriptResult}${await this.changeVerifier.verify([action.path])}`;
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
      const provider = await this.providerGateway.createProvider();
      const model = await this.models.resolveModel(provider, abort.signal);
      if (continuationPrompt) {
        this.emit({ type: "status", text: statusText });
      }
      const completedPendingTools = await this.continuePendingToolCalls(remainingInvocations);
      if (!completedPendingTools || abort.signal.aborted) {
        return;
      }
      await this.runModelLoopWithOverflowRecovery(provider, model, abort);
    } catch (error) {
      this.lastRunErrored = true;
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
      void this.learning.maybeRunBackgroundReview();
      void this.learning.maybeRunCuratorAuto();
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

  private ensureSystemMessage(): void {
    const nextSystemMessage = this.systemPrompt.build();
    const existingIndex = this.messages.findIndex((message) => message.role === "system");
    if (existingIndex >= 0) {
      this.messages[existingIndex] = nextSystemMessage;
      return;
    }

    this.appendMessage(nextSystemMessage);
  }

  // Build the curated-notes snapshot once per session. Frozen for the session so the system prompt
  // stays byte-stable; reset() clears the flag so the next run rebuilds it from disk.
  private async ensureMemoryInitialized(): Promise<void> {
    if (!this.memoryManager || this.memoryInitialized) {
      return;
    }
    await this.memoryManager.initializeAll({ sessionId: this.sessions.currentSessionId() ?? "session", reset: false });
    this.memoryInitialized = true;
  }

  private appendMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.sessions.persist((sessionId) => ({
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
    this.sessions.persist((sessionId) => ({
      type: "messages_replaced",
      sessionId,
      createdAt: Date.now(),
      messages,
      reason
    }));
  }

  private async recordApprovalRequested(approval: ApprovalRequest): Promise<void> {
    await this.sessions.record((sessionId) => ({
      type: "approval_requested",
      sessionId,
      createdAt: Date.now(),
      approval
    }));
  }

  private async recordApprovalResolved(approvalId: string, accepted: boolean, text: string): Promise<void> {
    await this.sessions.record((sessionId) => ({
      type: "approval_resolved",
      sessionId,
      createdAt: Date.now(),
      approvalId,
      accepted,
      text
    }));
  }

  // Public entry point for the view provider and the /undo command; the stack and restore live in
  // UndoManager.
  async undo(): Promise<void> {
    await this.undoManager.undo();
  }

  private async recordCheckpoint(action: AgentAction, summary: string): Promise<void> {
    await this.undoManager.capture(action, summary);
    await this.sessions.record((sessionId) => ({
      type: "checkpoint",
      sessionId,
      createdAt: Date.now(),
      action,
      summary
    }));
  }

  private applySession(snapshot: SessionSnapshot): void {
    this.sessions.adoptSession(snapshot.id);
    this.messages = [...snapshot.messages];
    this.memoryInitialized = false;
    // Hydrate the review cadence from prior user turns so resuming a session doesn't re-fire reviews
    // for work already reviewed (Hermes turn_context hydration).
    this.userTurnCount = snapshot.messages.filter((message) => message.role === "user").length;
    this.toolIterationCount = 0;
    this.learning.onSessionRestored(snapshot.messages.length);
    this.taskBoard.restoreFromSessionRecords(snapshot.records);
    this.lastContextItems = [];
    this.mcp.reset();
    this.pinned.clear();
    this.readFileState.clear();
    this.notebookReadState.clear();
    this.inspector.reset();
    this.lastTokenUsage = undefined;
    this.approvals.restore(snapshot.pendingApprovals);
    this.workerApprovalWaiters.clear();
    this.workers.restoreFromSessionRecords(snapshot.records);
  }

  private emit(event: AgentUiEvent): void {
    this.events.emit("event", event);
  }

  private emitWorkerStarted(worker: WorkerSummary): void {
    this.emit({
      type: "message",
      role: "system",
      text: `${worker.label} worker started: ${worker.id}\n\nUse /worker output ${worker.id} to view its transcript or /worker stop ${worker.id} to stop it.`
    });
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
    const inspection = this.models.getInspection(activeProfile.id);
    const modelInfo = inspection?.models.map(toAgentModelSummary) ?? [];
    const models = modelInfo.map((model) => model.id);
    const selectedModel = this.models.selectedModelFor(activeProfile, inspection);
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
      mcpServers: this.mcp.serverStatusSummaries(),
      mcpContext: this.mcp.resourceSummaries(),
      workers: this.workers.list(),
      activeContext: await this.activeContextSummary(),
      memories: await this.memoryCommands.summaries(),
      capabilityCache: await this.providerGateway.capabilitySummaries(activeProfile.id),
      inspector: this.inspector.summary(),
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
      pinnedFiles: this.pinned.list()
    };
  }

  // Thin delegates to the context manager (kept on the controller so the many call sites and the
  // worker/learning deps stay unchanged).
  private emitContextUsage(): void {
    this.context.emitUsage();
  }

  private currentContextUsage(): ContextUsage {
    return this.context.currentUsage();
  }

  private effectiveContextLimits(): ContextLimits {
    return this.context.effectiveContextLimits();
  }

  private requestMaxTokens(): number | undefined {
    return this.context.requestMaxTokens();
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


function readStateKey(path: string): string {
  return normalizeWorkspacePathInput(path).replace(/^\/+/, "").replace(/^\.\//, "");
}

function readFileContentFromToolResult(result: string, path: string): string {
  const prefix = `read_file ${path}\n\n`;
  return result.startsWith(prefix) ? result.slice(prefix.length) : result.replace(/^read_file[^\n]*\n\n/, "");
}

function summaryForInvocation(invocation: ToolInvocation): string {
  try {
    return toolSummary(invocation.action);
  } catch {
    return invocation.action.type;
  }
}
