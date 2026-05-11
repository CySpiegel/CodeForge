import { parseActionsFromAssistantText, parseToolActionDetailed } from "../core/actionProtocol";
import { ContextBuilder } from "../core/contextBuilder";
import { executeLocalReadOnlyTools, LocalToolProgress } from "../core/localToolExecutor";
import { MemoryEntry } from "../core/memory";
import { evaluateActionPermission } from "../core/permissions";
import { SessionRecord } from "../core/session";
import {
  AgentAction,
  ChatMessage,
  ContextItem,
  ContextLimits,
  LlmProvider,
  ModelInfo,
  PermissionPolicy,
  ProviderCapabilities,
  ToolCall,
  ToolDefinition,
  WorkspacePort
} from "../core/types";
import { isLocalReadOnlyAction, toolDefinitions, ToolInvocation, validateAction } from "../core/toolRegistry";
import { findWorkerDefinition, isWorkerKind, workerDefinitions } from "../core/workerAgents";
import { WorkerDefinition, WorkerKind, WorkerSessionEvent, WorkerStatus, WorkerSummary, WorkerTranscriptEntry } from "../core/workerTypes";

export interface WorkerManagerOptions {
  readonly workspace: WorkspacePort;
  readonly contextLimits: () => ContextLimits;
  readonly memories: (definition: WorkerDefinition) => Promise<readonly MemoryEntry[]>;
  readonly mcpResources: () => readonly ContextItem[];
  readonly createProvider: () => Promise<LlmProvider>;
  readonly resolveModel: (provider: LlmProvider, signal: AbortSignal) => Promise<string>;
  readonly capabilities: (provider: LlmProvider, model: string, signal: AbortSignal) => Promise<ProviderCapabilities>;
  readonly selectedModelInfo: () => ModelInfo | undefined;
  readonly permissionPolicy: () => PermissionPolicy;
  readonly executeAction: (action: AgentAction, toolCallId: string | undefined, worker: WorkerSummary) => Promise<string>;
  readonly record: (factory: (sessionId: string) => SessionRecord) => void;
  readonly onDidChange: (workers: readonly WorkerSummary[]) => void;
  readonly onNotice: (message: string) => void;
}

interface WorkerTask {
  id: string;
  definition: WorkerDefinition;
  status: WorkerStatus;
  prompt: string;
  summary?: string;
  error?: string;
  model?: string;
  profileLabel?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  toolUseCount: number;
  tokenCount: number;
  filesInspected: Set<string>;
  messages: ChatMessage[];
  transcript: WorkerTranscriptEntry[];
  abortController?: AbortController;
  lastSummaryEmitAt?: number;
}

interface WorkerInvocationParseResult {
  readonly invocations: readonly ToolInvocation[];
  readonly hadInvalidNativeToolCalls: boolean;
}

const maxTranscriptEntries = 120;
const maxTranscriptTextBytes = 80_000;
const summaryEmitIntervalMs = 250;

const workerReadToolInstruction = `When you need workspace data, request one or more actions using this JSON shape and only these action types:

{
  "actions": [
    { "type": "list_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "glob_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "read_file", "path": "relative/path.ts", "reason": "why" },
    { "type": "search_text", "query": "symbol or text", "reason": "why" },
    { "type": "grep_text", "query": "symbol or text", "include": "src/**/*.ts", "limit": 50, "reason": "why" },
    { "type": "list_diagnostics", "path": "relative/path.ts", "limit": 50, "reason": "why" }
  ]
}

Use workspace-relative paths only. If a tool is denied, adjust within the allowed read-only scope.`;

const workerCodeIntelToolInstruction = `This worker may also use VS Code language-service tools when symbol-aware code intelligence is more reliable than text search:

{
  "actions": [
    { "type": "code_hover", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_definition", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_references", "path": "relative/path.ts", "line": 10, "character": 5, "includeDeclaration": false, "reason": "why" },
    { "type": "code_symbols", "path": "relative/path.ts", "reason": "why" }
  ]
}`;

const workerStateToolInstruction = `This worker may also use local task-state tools to track multi-step work internally:

{
  "actions": [
    { "type": "tool_list", "reason": "inspect available tools" },
    { "type": "task_create", "subject": "short task", "description": "details", "reason": "why" },
    { "type": "task_update", "taskId": "task-1234567890-abc", "status": "in_progress", "reason": "why" },
    { "type": "task_list", "reason": "check current tasks" },
    { "type": "task_get", "taskId": "task-1234567890-abc", "reason": "why" }
  ]
}

Tasks are local session state for coordination and progress tracking. They do not edit workspace files.`;

const workerQuestionToolInstruction = `This worker may also pause and ask the user a structured question when blocked by missing requirements:

{
  "actions": [
    { "type": "ask_user_question", "questions": [{ "question": "Which implementation path should I use?", "header": "Approach", "options": [{ "label": "Small patch", "description": "Make the narrowest change." }, { "label": "Refactor", "description": "Restructure before editing." }] }], "reason": "why the answer is needed" }
  ]
}

Ask only when the answer changes the implementation.`;

const workerNotebookToolInstruction = `This worker may also use VS Code notebook tools:

{
  "actions": [
    { "type": "notebook_read", "path": "notebooks/example.ipynb", "reason": "why" },
    { "type": "notebook_edit_cell", "path": "notebooks/example.ipynb", "index": 0, "content": "print('hello')", "language": "python", "kind": "code", "reason": "why" }
  ]
}

Notebook edits are routed through the parent VS Code approval, checkpoint, and permission policy.`;

const workerEditToolInstruction = `This worker may also request approval-gated edit actions when edits are needed:

{
  "actions": [
    { "type": "edit_file", "path": "relative/path.ts", "oldText": "exact text", "newText": "replacement text", "reason": "why" },
    { "type": "write_file", "path": "relative/path.ts", "content": "full file text", "reason": "why" },
    { "type": "propose_patch", "patch": "unified diff", "reason": "why" },
    { "type": "open_diff", "patch": "unified diff", "reason": "why" }
  ]
}

Read before editing. Use workspace-relative paths only. Edits are not hidden background changes; CodeForge routes them through the parent VS Code approval, diff preview, checkpoint, and permission policy.`;

const workerCommandToolInstruction = `This worker may also request approval-gated local command execution when verification or diagnostics require it:

{
  "actions": [
    { "type": "run_command", "command": "npm test", "cwd": ".", "reason": "why this command is needed" }
  ]
}

Prefer VS Code-native read/search/diagnostic tools first. Keep commands workspace-scoped, foreground, and bounded. Commands are routed through the parent VS Code approval, checkpoint, timeout, output limit, and permission policy.`;

const workerAutomationToolInstruction = `This worker may also delegate focused work to another CodeForge agent:

{
  "actions": [
    { "type": "spawn_agent", "agent": "review", "prompt": "focused task", "description": "short label", "background": false, "reason": "why" },
    { "type": "worker_output", "workerId": "worker-id", "reason": "why" }
  ]
}

Use delegation for independent review, exploration, or verification work. The spawned agent inherits CodeForge's local endpoint, workspace context, permission policy, and approval bridge.`;

const workerMemoryToolInstruction = `This worker may also request approval to save durable local memory:

{
  "actions": [
    { "type": "memory_write", "text": "stable preference or repository fact", "scope": "agent", "agent": "agent-name", "reason": "why this should persist" }
  ]
}

Only save stable user preferences or repository facts that should affect future sessions. Memory writes are persistent, local, inspectable, and approval-gated.`;

const workerMcpResourceToolInstruction = `This worker may also read resources from explicitly configured local/on-prem MCP servers:

{
  "actions": [
    { "type": "mcp_list_resources", "serverId": "configured-server", "reason": "why" },
    { "type": "mcp_read_resource", "serverId": "configured-server", "uri": "resource-uri", "reason": "why" }
  ]
}

Never invent MCP server IDs.`;

export class WorkerManager {
  private readonly options: WorkerManagerOptions;
  private readonly tasks = new Map<string, WorkerTask>();

  constructor(options: WorkerManagerOptions) {
    this.options = options;
  }

  list(): readonly WorkerSummary[] {
    return [...this.tasks.values()].map(summarizeWorker).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  clear(): void {
    for (const task of this.tasks.values()) {
      task.abortController?.abort();
    }
    this.tasks.clear();
    this.emitChanged();
  }

  definitions(): readonly WorkerDefinition[] {
    return workerDefinitions;
  }

  isKnownKind(value: string): value is WorkerKind {
    return isWorkerKind(value);
  }

  spawn(kind: WorkerKind, prompt: string): WorkerSummary {
    const definition = findWorkerDefinition(kind);
    if (!definition) {
      throw new Error(`Unknown worker kind: ${kind}`);
    }
    return this.spawnDefinition(definition, prompt);
  }

  spawnDefinition(definition: WorkerDefinition, prompt: string): WorkerSummary {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new Error(`Usage: ${definition.slashCommand} <task>`);
    }

    const now = Date.now();
    const task: WorkerTask = {
      id: `worker-${now}-${Math.random().toString(16).slice(2)}`,
      definition,
      status: "running",
      prompt: trimmedPrompt,
      startedAt: now,
      updatedAt: now,
      toolUseCount: 0,
      tokenCount: 0,
      filesInspected: new Set<string>(),
      messages: [],
      transcript: [],
      abortController: new AbortController()
    };
    this.tasks.set(task.id, task);
    this.appendTranscript(task, "status", `${definition.label} worker started: ${trimmedPrompt}`, "started");
    this.emitChanged();
    void this.run(task);
    return summarizeWorker(task);
  }

  stop(workerId: string): boolean {
    const task = this.tasks.get(workerId);
    if (!task || task.status !== "running") {
      return false;
    }
    task.abortController?.abort();
    this.finish(task, "stopped", "Stopped by user.");
    return true;
  }

  output(workerId: string): string | undefined {
    const task = this.tasks.get(workerId);
    if (!task) {
      return undefined;
    }
    const header = [
      `${task.definition.label} worker ${task.id}`,
      `Status: ${task.status}`,
      `Prompt: ${task.prompt}`,
      task.model ? `Model: ${task.model}` : undefined,
      task.profileLabel ? `Endpoint: ${task.profileLabel}` : undefined,
      `Tools: ${task.toolUseCount}`,
      `Tokens: ${task.tokenCount}`,
      task.filesInspected.size > 0 ? `Files inspected: ${[...task.filesInspected].sort().join(", ")}` : "Files inspected: none recorded"
    ].filter((line): line is string => Boolean(line));
    const transcript = task.transcript.map((entry) => {
      return `[${new Date(entry.createdAt).toLocaleString()}] ${entry.role.toUpperCase()}\n${entry.text}`;
    });
    return [...header, "", ...transcript].join("\n");
  }

  summary(workerId: string): WorkerSummary | undefined {
    const task = this.tasks.get(workerId);
    return task ? summarizeWorker(task) : undefined;
  }

  async waitFor(workerId: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkerSummary | undefined> {
    const started = Date.now();
    while (!signal?.aborted && Date.now() - started < timeoutMs) {
      const summary = this.summary(workerId);
      if (!summary || summary.status !== "running") {
        return summary;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.summary(workerId);
  }

  restoreFromSessionRecords(records: readonly SessionRecord[]): void {
    for (const task of this.tasks.values()) {
      task.abortController?.abort();
    }
    this.tasks.clear();

    for (const record of records) {
      if (record.type !== "worker") {
        continue;
      }
      const definition = findWorkerDefinition(record.worker.kind) ?? restoredWorkerDefinition(record.worker);
      if (!definition) {
        continue;
      }
      const current = this.tasks.get(record.worker.id);
      const task = current ?? {
        id: record.worker.id,
        definition,
        status: record.worker.status,
        prompt: record.worker.prompt,
        startedAt: record.worker.startedAt,
        updatedAt: record.worker.updatedAt,
        toolUseCount: record.worker.toolUseCount,
        tokenCount: record.worker.tokenCount,
        filesInspected: new Set(record.worker.filesInspected),
        messages: [],
        transcript: []
      };
      task.status = record.worker.status === "running" ? "stopped" : record.worker.status;
      task.summary = record.worker.status === "running" ? "Stopped when the VS Code session ended." : record.worker.summary;
      task.error = record.worker.error;
      task.model = record.worker.model;
      task.profileLabel = record.worker.profileLabel;
      task.updatedAt = record.worker.updatedAt;
      task.completedAt = record.worker.completedAt;
      task.toolUseCount = record.worker.toolUseCount;
      task.tokenCount = record.worker.tokenCount;
      task.filesInspected = new Set(record.worker.filesInspected);
      if (record.transcriptEntry && !task.transcript.some((entry) => entry.createdAt === record.transcriptEntry?.createdAt && entry.role === record.transcriptEntry.role && entry.text === record.transcriptEntry.text)) {
        task.transcript.push(record.transcriptEntry);
      }
      this.tasks.set(task.id, task);
    }
    this.emitChanged();
  }

  private async run(task: WorkerTask): Promise<void> {
    const abort = task.abortController;
    if (!abort) {
      return;
    }

    try {
      const provider = await this.options.createProvider();
      const model = await this.options.resolveModel(provider, abort.signal);
      const capabilities = await this.options.capabilities(provider, model, abort.signal);
      task.profileLabel = provider.profile.label;
      task.model = model;
      this.touch(task);
      this.appendTranscript(task, "status", `Calling ${provider.profile.label} / ${model}.`);

      const context = new ContextBuilder(this.options.workspace, this.effectiveContextLimits(), {
        memories: await this.options.memories(task.definition),
        mcpResources: this.options.mcpResources()
      });
      const contextItems = await context.build(abort.signal);
      const contextText = context.format(contextItems);
      const allowedTools = toolsForWorker(task.definition);
      task.messages = [
        { role: "system", content: this.systemPrompt(task.definition) },
        { role: "user", content: `${task.definition.label} worker task:\n\n${task.prompt}\n\nCodeForge workspace context:\n\n${contextText}` }
      ];
      this.appendTranscript(task, "user", task.prompt);

      for (let iteration = 0; iteration < task.definition.maxTurns; iteration++) {
        if (abort.signal.aborted || task.status !== "running") {
          return;
        }

        let assistantText = "";
        const nativeToolCalls: ToolCall[] = [];
        for await (const event of provider.streamChat({
          model,
          messages: task.messages,
          tools: capabilities.nativeToolCalls ? allowedTools : undefined,
          signal: abort.signal
        })) {
          if (event.type === "content") {
            assistantText += event.text;
            this.updateSummary(task, assistantText);
          } else if (event.type === "toolCalls") {
            nativeToolCalls.push(...event.toolCalls);
          } else if (event.type === "usage") {
            task.tokenCount = event.usage.totalTokens ?? event.usage.promptTokens ?? task.tokenCount;
            this.touch(task);
          }
        }

        if (assistantText.trim() || nativeToolCalls.length > 0) {
          task.messages.push({ role: "assistant", content: assistantText, toolCalls: nativeToolCalls });
          if (assistantText.trim()) {
            this.appendTranscript(task, "assistant", assistantText);
          }
        }

        const parsedInvocations = this.invocationsFromAssistant(task, nativeToolCalls, assistantText, iteration);
        if (parsedInvocations.invocations.length === 0) {
          if (parsedInvocations.hadInvalidNativeToolCalls) {
            continue;
          }
          this.finish(task, "completed", finalSummary(assistantText, task.summary));
          return;
        }

        const continued = await this.executeInvocations(task, parsedInvocations.invocations);
        if (!continued) {
          this.finish(task, "failed", "Worker stopped because every requested tool action was outside its allowed scope.");
          return;
        }
      }

      this.finish(task, "completed", `${task.summary ?? "Worker completed."}\n\n[Stopped after the worker tool loop limit.]`);
    } catch (error) {
      if (task.status === "stopped") {
        return;
      }
      this.finish(task, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private invocationsFromAssistant(task: WorkerTask, nativeToolCalls: readonly ToolCall[], assistantText: string, iteration: number): WorkerInvocationParseResult {
    const native: ToolInvocation[] = [];
    let hadInvalidNativeToolCalls = false;
    for (const toolCall of nativeToolCalls) {
      const parsed = parseToolActionDetailed(toolCall.name, toolCall.argumentsJson);
      if (parsed.ok) {
        native.push({
          id: toolCall.id,
          action: parsed.action,
          source: "native",
          toolCallId: toolCall.id
        });
      } else {
        hadInvalidNativeToolCalls = true;
        this.appendInvalidNativeToolCallResult(task, toolCall, parsed.message);
      }
    }
    const fallback = parseActionsFromAssistantText(assistantText).map((action, index): ToolInvocation => ({
      id: `${task.id}-json-${iteration}-${index}`,
      action,
      source: "json"
    }));
    return { invocations: [...native, ...fallback], hadInvalidNativeToolCalls };
  }

  private async executeInvocations(task: WorkerTask, invocations: readonly ToolInvocation[]): Promise<boolean> {
    const executable: ToolInvocation[] = [];
    let anyAllowed = false;

    for (const invocation of invocations) {
      task.toolUseCount++;
      const validation = validateAction(invocation.action);
      if (!validation.ok) {
        this.appendWorkerToolResult(task, invocation, toolError(validation.message ?? "Tool input failed validation."));
        continue;
      }
      if (!toolAllowedForWorker(task.definition, invocation.action.type)) {
        this.appendWorkerToolResult(task, invocation, toolError(`${task.definition.label} workers cannot use ${invocation.action.type}. This worker is scoped to: ${task.definition.allowedToolNames.join(", ")}.`));
        continue;
      }
      if (isLocalReadOnlyAction(invocation.action)) {
        const decision = evaluateActionPermission(invocation.action, this.options.permissionPolicy());
        if (decision.behavior !== "allow") {
          this.appendWorkerToolResult(task, invocation, toolError(`${invocation.action.type} was not allowed by the parent permission policy. ${decision.reason}`));
          continue;
        }
        anyAllowed = true;
        trackActionPath(task, invocation.action);
        executable.push(invocation);
        continue;
      }

      anyAllowed = true;
      trackActionPath(task, invocation.action);
      if (executable.length > 0) {
        await this.executeReadOnlyInvocations(task, executable.splice(0));
      }
      this.appendTranscript(task, "status", `requested: ${invocation.action.type}`);
      let result: string;
      try {
        result = await this.options.executeAction(invocation.action, invocation.toolCallId, summarizeWorker(task));
      } catch (error) {
        result = toolError(error instanceof Error ? error.message : String(error));
      }
      trackResultPaths(task, result);
      this.appendWorkerToolResult(task, invocation, result);
    }

    if (executable.length === 0) {
      this.touch(task);
      return anyAllowed;
    }

    await this.executeReadOnlyInvocations(task, executable);
    return true;
  }

  private async executeReadOnlyInvocations(task: WorkerTask, executable: readonly ToolInvocation[]): Promise<void> {
    const results = await executeLocalReadOnlyTools(executable, {
      workspace: this.options.workspace,
      readFileMaxBytes: 48000,
      searchLimit: 40,
      signal: task.abortController?.signal,
      onProgress: (progress) => this.onToolProgress(task, progress)
    });

    for (const result of results) {
      trackResultPaths(task, result.content);
      this.appendWorkerToolResult(task, result.invocation, result.content);
    }
  }

  private appendWorkerToolResult(task: WorkerTask, invocation: ToolInvocation, content: string): void {
    if (invocation.toolCallId) {
      task.messages.push({ role: "tool", name: invocation.action.type, toolCallId: invocation.toolCallId, content });
    } else {
      task.messages.push({ role: "user", content: `CodeForge worker local tool result:\n\n${content}` });
    }
    this.appendTranscript(task, "tool", content);
  }

  private appendInvalidNativeToolCallResult(task: WorkerTask, toolCall: ToolCall, message: string): void {
    const content = toolError(message);
    task.messages.push({ role: "tool", name: toolCall.name || "tool", toolCallId: toolCall.id, content });
    this.appendTranscript(task, "tool", content);
    this.touch(task);
  }

  private onToolProgress(task: WorkerTask, progress: LocalToolProgress): void {
    if (progress.status === "running") {
      task.summary = progress.summary;
      this.appendTranscript(task, "status", `${progress.status}: ${progress.summary}`);
    }
    this.touch(task);
  }

  private systemPrompt(definition: WorkerDefinition): string {
    return [
      definition.systemPrompt,
      "",
      workerToolInstruction(definition),
      "",
      "Network policy: CodeForge is local/offline first and only talks to configured local or on-prem OpenAI-compatible endpoints. Never suggest sending workspace data to a public service."
    ].join("\n");
  }

  private effectiveContextLimits(): ContextLimits {
    const configured = this.options.contextLimits();
    const selectedModel = this.options.selectedModelInfo();
    if (!selectedModel?.contextLength) {
      return configured;
    }
    const usableTokens = Math.max(1024, Math.floor(selectedModel.contextLength * 0.65));
    return {
      ...configured,
      maxBytes: Math.min(configured.maxBytes, Math.max(8000, usableTokens * 4))
    };
  }

  private updateSummary(task: WorkerTask, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    task.summary = firstLine(trimmed);
    task.updatedAt = Date.now();
    if (!task.lastSummaryEmitAt || task.updatedAt - task.lastSummaryEmitAt >= summaryEmitIntervalMs) {
      task.lastSummaryEmitAt = task.updatedAt;
      this.emitChanged();
    }
  }

  private finish(task: WorkerTask, status: WorkerStatus, message: string): void {
    if (task.status !== "running" && task.status !== "stopped") {
      return;
    }
    const now = Date.now();
    task.status = status;
    task.updatedAt = now;
    task.completedAt = now;
    task.abortController = undefined;
    if (status === "failed") {
      task.error = message;
    } else {
      task.summary = message;
    }
    const event: WorkerSessionEvent = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed";
    this.appendTranscript(task, "status", message, event);
    this.emitChanged();
    this.options.onNotice(`${task.definition.label} worker ${status}: ${firstLine(message)}`);
  }

  private appendTranscript(task: WorkerTask, role: WorkerTranscriptEntry["role"], text: string, event: WorkerSessionEvent = "progress"): void {
    const entry: WorkerTranscriptEntry = {
      workerId: task.id,
      createdAt: Date.now(),
      role,
      text: clipTranscriptText(text)
    };
    task.transcript.push(entry);
    while (task.transcript.length > maxTranscriptEntries) {
      task.transcript.shift();
    }
    task.updatedAt = entry.createdAt;
    const summary = summarizeWorker(task);
    this.options.record((sessionId) => ({
      type: "worker",
      sessionId,
      createdAt: entry.createdAt,
      event,
      worker: summary,
      transcriptEntry: entry
    }));
    this.emitChanged();
  }

  private touch(task: WorkerTask): void {
    task.updatedAt = Date.now();
    this.options.record((sessionId) => ({
      type: "worker",
      sessionId,
      createdAt: task.updatedAt,
      event: "progress",
      worker: summarizeWorker(task)
    }));
    this.emitChanged();
  }

  private emitChanged(): void {
    this.options.onDidChange(this.list());
  }
}

function toolsForWorker(definition: WorkerDefinition): readonly ToolDefinition[] {
  return toolDefinitions.filter((tool) => definition.allowedToolNames.includes(tool.name));
}

function workerToolInstruction(definition: WorkerDefinition): string {
  const canEdit = definition.allowedToolNames.some((tool) => tool === "edit_file" || tool === "write_file" || tool === "propose_patch" || tool === "open_diff");
  const canCommand = definition.allowedToolNames.some((tool) => tool === "run_command");
  const canAutomate = definition.allowedToolNames.some((tool) => tool === "spawn_agent" || tool === "worker_output");
  const canRemember = definition.allowedToolNames.some((tool) => tool === "memory_write");
  const canCodeIntel = definition.allowedToolNames.some((tool) => tool === "code_hover" || tool === "code_definition" || tool === "code_references" || tool === "code_symbols");
  const canState = definition.allowedToolNames.some((tool) => tool === "tool_list" || tool === "task_create" || tool === "task_update" || tool === "task_list" || tool === "task_get");
  const canQuestion = definition.allowedToolNames.some((tool) => tool === "ask_user_question");
  const canMcpResource = definition.allowedToolNames.some((tool) => tool === "mcp_list_resources" || tool === "mcp_read_resource");
  const canNotebook = definition.allowedToolNames.some((tool) => tool === "notebook_read" || tool === "notebook_edit_cell");
  return [
    workerReadToolInstruction,
    canCodeIntel ? workerCodeIntelToolInstruction : undefined,
    canState ? workerStateToolInstruction : undefined,
    canQuestion ? workerQuestionToolInstruction : undefined,
    canNotebook ? workerNotebookToolInstruction : undefined,
    canEdit ? workerEditToolInstruction : undefined,
    canCommand ? workerCommandToolInstruction : undefined,
    canAutomate ? workerAutomationToolInstruction : undefined,
    canRemember ? workerMemoryToolInstruction : undefined,
    canMcpResource ? workerMcpResourceToolInstruction : undefined
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

function toolAllowedForWorker(definition: WorkerDefinition, toolName: AgentAction["type"]): boolean {
  return definition.allowedToolNames.includes(toolName);
}

function restoredWorkerDefinition(worker: WorkerSummary): WorkerDefinition | undefined {
  if (worker.kind !== "custom") {
    return undefined;
  }
  return {
    kind: "custom",
    label: worker.label,
    description: "Restored workspace-local CodeForge agent.",
    slashCommand: "/agent-run",
    maxTurns: 1,
    allowedToolNames: [],
    systemPrompt: "Restored workspace-local CodeForge agent."
  };
}

function summarizeWorker(task: WorkerTask): WorkerSummary {
  return {
    id: task.id,
    kind: task.definition.kind,
    label: task.definition.label,
    status: task.status,
    prompt: task.prompt,
    summary: task.summary,
    error: task.error,
    model: task.model,
    profileLabel: task.profileLabel,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    toolUseCount: task.toolUseCount,
    tokenCount: task.tokenCount,
    filesInspected: [...task.filesInspected].sort()
  };
}

function trackActionPath(task: WorkerTask, action: AgentAction): void {
  if (action.type === "read_file" || action.type === "write_file" || action.type === "edit_file") {
    task.filesInspected.add(action.path);
  } else if (action.type === "list_diagnostics" && action.path) {
    task.filesInspected.add(action.path);
  }
}

function trackResultPaths(task: WorkerTask, content: string): void {
  const pattern = /(?:^|\s)([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*(?:\.[A-Za-z0-9]+)?)(?::\d+)?/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const path = match[1];
    if (path && looksLikeWorkspacePath(path)) {
      task.filesInspected.add(path);
    }
    if (task.filesInspected.size >= 40) {
      return;
    }
  }
}

function toolError(message: string): string {
  return `<tool_use_error>Error: ${message}</tool_use_error>`;
}

function finalSummary(assistantText: string, fallback: string | undefined): string {
  const trimmed = assistantText.trim();
  return trimmed || fallback || "Worker completed without a final text response.";
}

function clipTranscriptText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxTranscriptTextBytes) {
    return text;
  }
  const marker = "\n\n[CodeForge clipped this worker transcript entry to keep local session history bounded.]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(1, maxTranscriptTextBytes - markerBytes);
  return `${Buffer.from(text).subarray(0, budget).toString("utf8")}${marker}`;
}

function looksLikeWorkspacePath(value: string): boolean {
  if (!value || value.startsWith("http") || value.includes("://") || value.includes("\0")) {
    return false;
  }
  if (value === "." || value === ".." || value.includes("..")) {
    return false;
  }
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).find((item) => item.trim())?.trim() ?? "";
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}
