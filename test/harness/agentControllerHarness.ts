import { AgentController, AgentUiEvent } from "../../src/agent/agentController";
import { CodeForgeConfigService } from "../../src/adapters/vscodeConfig";
import { DiffService } from "../../src/adapters/diffService";
import { TerminalRunner } from "../../src/adapters/terminalRunner";
import { CodeIntelAction, CodeIntelPort } from "../../src/core/codeIntel";
import { MemoryEntry, MemoryListFilter, MemoryStore, MemoryWriteOptions } from "../../src/core/memory";
import { NotebookAction, NotebookPort } from "../../src/core/notebooks";
import { applyFilePatch, parseUnifiedDiff, targetPath } from "../../src/core/unifiedDiff";
import {
  AgentMode,
  CommandResult,
  ContextItem,
  ContextLimits,
  DiagnosticSeverity,
  EditFileAction,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  McpServerConfig,
  ModelInfo,
  OpenAiEndpointInspection,
  PermissionMode,
  PermissionPolicy,
  ProviderCapabilities,
  ProviderProfile,
  RunCommandAction,
  SearchResult,
  TokenUsage,
  ToolCall,
  WriteFileAction,
  WorkspaceDiagnostic,
  WorkspacePort
} from "../../src/core/types";

export interface ScriptedLlmResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: TokenUsage;
  readonly waitBeforeDone?: Promise<void>;
}

export class ScriptedLlmProvider implements LlmProvider {
  readonly profile: ProviderProfile;
  readonly requests: LlmRequest[] = [];
  private readonly responses: ScriptedLlmResponse[];

  constructor(responses: readonly ScriptedLlmResponse[], profile: ProviderProfile = fakeProfile) {
    this.responses = [...responses];
    this.profile = profile;
  }

  async *streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No scripted LLM response for request ${this.requests.length}.`);
    }
    if (response.usage) {
      yield { type: "usage", usage: response.usage };
    }
    if (response.content) {
      yield { type: "content", text: response.content };
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      yield { type: "toolCalls", toolCalls: response.toolCalls };
    }
    if (response.waitBeforeDone) {
      await response.waitBeforeDone;
    }
    yield { type: "done" };
  }

  async listModels(): Promise<readonly string[]> {
    return [this.profile.defaultModel ?? "fake-model"];
  }

  async inspectEndpoint(): Promise<OpenAiEndpointInspection> {
    return {
      backend: "openai-api",
      backendLabel: "Fake OpenAI API compatible",
      models: [this.modelInfo()]
    };
  }

  async probeCapabilities(): Promise<ProviderCapabilities> {
    return { streaming: true, modelListing: true, nativeToolCalls: true };
  }

  private modelInfo(): ModelInfo {
    return {
      id: this.profile.defaultModel ?? "fake-model",
      contextLength: 32768,
      maxOutputTokens: 4096,
      supportsReasoning: false
    };
  }
}

export function toolCall(name: string, args: Record<string, unknown> = {}, id = `call-${name}`): ToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) };
}

export class FakeWorkspace implements WorkspacePort {
  readonly files = new Map<string, string>();
  readonly diagnostics: WorkspaceDiagnostic[] = [];
  activeDocument: ContextItem | undefined;
  selection: ContextItem | undefined;

  constructor(files: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(normalizePath(path), content);
    }
  }

  async listTextFiles(limit: number): Promise<readonly string[]> {
    return [...this.files.keys()].slice(0, limit);
  }

  async listFiles(pattern: string | undefined, limit: number): Promise<readonly string[]> {
    return this.matchingFiles(pattern).slice(0, limit);
  }

  async globFiles(pattern: string, limit: number): Promise<readonly string[]> {
    return this.matchingFiles(pattern).slice(0, limit);
  }

  async readTextFile(path: string, maxBytes: number): Promise<string> {
    const content = this.files.get(normalizePath(path));
    if (content === undefined) {
      throw new Error(`No such file: ${path}`);
    }
    return Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
  }

  async getActiveTextDocument(): Promise<ContextItem | undefined> {
    return this.activeDocument;
  }

  async getOpenTextDocuments(): Promise<readonly ContextItem[]> {
    return [];
  }

  async getActiveSelection(): Promise<ContextItem | undefined> {
    return this.selection;
  }

  async searchText(query: string, limit: number): Promise<readonly SearchResult[]> {
    return this.search(query, undefined).slice(0, limit);
  }

  async grepText(query: string, include: string | undefined, limit: number): Promise<readonly SearchResult[]> {
    return this.search(query, include).slice(0, limit);
  }

  async getDiagnostics(path: string | undefined, limit: number): Promise<readonly WorkspaceDiagnostic[]> {
    const normalizedPath = path ? normalizePath(path) : undefined;
    return this.diagnostics
      .filter((diagnostic) => !normalizedPath || normalizePath(diagnostic.path) === normalizedPath)
      .slice(0, limit);
  }

  write(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }

  edit(action: EditFileAction): void {
    const path = normalizePath(action.path);
    const original = this.files.get(path) ?? "";
    if (!original.includes(action.oldText)) {
      throw new Error(`edit_file oldText was not found in ${action.path}.`);
    }
    this.files.set(path, action.replaceAll ? original.split(action.oldText).join(action.newText) : original.replace(action.oldText, action.newText));
  }

  addDiagnostic(path: string, message: string, severity: DiagnosticSeverity = "error"): void {
    this.diagnostics.push({ path: normalizePath(path), line: 1, character: 1, severity, message });
  }

  private matchingFiles(pattern: string | undefined): readonly string[] {
    return [...this.files.keys()].filter((path) => globMatches(pattern, path));
  }

  private search(query: string, include: string | undefined): readonly SearchResult[] {
    const needle = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const [path, content] of this.files) {
      if (!globMatches(include, path)) {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLowerCase().includes(needle)) {
          results.push({ path, line: index + 1, preview: lines[index] });
        }
      }
    }
    return results;
  }
}

export class FakeDiffService {
  readonly writes: WriteFileAction[] = [];
  readonly edits: EditFileAction[] = [];
  readonly patches: string[] = [];
  readonly previews: string[] = [];

  constructor(private readonly workspace: FakeWorkspace) {}

  async previewPatch(patch: string): Promise<void> {
    this.previews.push(patch);
  }

  async previewWriteFile(action: WriteFileAction): Promise<void> {
    this.previews.push(action.path);
  }

  async previewEditFile(action: EditFileAction): Promise<void> {
    const original = this.workspace.files.get(normalizePath(action.path)) ?? "";
    if (!original.includes(action.oldText)) {
      throw new Error(`edit_file oldText was not found in ${action.path}.\n\nCurrent file excerpts that may be relevant:\n1: ${original.split(/\r?\n/)[0] ?? ""}`);
    }
    this.previews.push(action.path);
  }

  async applyPatch(patch: string): Promise<readonly string[]> {
    this.patches.push(patch);
    const changed: string[] = [];
    for (const filePatch of parseUnifiedDiff(patch)) {
      const path = targetPath(filePatch);
      const original = await this.workspace.readTextFile(path, 2_000_000).catch(() => "");
      this.workspace.write(path, applyFilePatch(original, filePatch));
      changed.push(path);
    }
    return changed;
  }

  async applyWriteFile(action: WriteFileAction): Promise<readonly string[]> {
    this.writes.push(action);
    this.workspace.write(action.path, action.content);
    return [action.path];
  }

  async applyEditFile(action: EditFileAction): Promise<readonly string[]> {
    this.edits.push(action);
    this.workspace.edit(action);
    return [action.path];
  }
}

export class FakeTerminalRunner {
  readonly commands: RunCommandAction[] = [];

  async run(action: RunCommandAction): Promise<CommandResult> {
    this.commands.push(action);
    return {
      exitCode: 0,
      stdout: `ran ${action.command}`,
      stderr: "",
      timedOut: false,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      outputLimitBytes: 12000,
      cwd: action.cwd ?? ".",
      startedAt: Date.now(),
      endedAt: Date.now()
    };
  }
}

export class FakeCodeIntelPort implements CodeIntelPort {
  readonly actions: CodeIntelAction[] = [];

  async execute(action: CodeIntelAction): Promise<string> {
    this.actions.push(action);
    const target = "path" in action && action.path ? action.path : "query" in action && action.query ? action.query : "";
    return `${action.type} ${target}`.trim();
  }
}

export class FakeNotebookPort implements NotebookPort {
  readonly actions: NotebookAction[] = [];

  async execute(action: NotebookAction): Promise<string> {
    this.actions.push(action);
    return `${action.type} ${action.path}`;
  }
}

export class FakeMemoryStore implements MemoryStore {
  readonly memories: MemoryEntry[] = [];

  async add(text: string, options: MemoryWriteOptions = {}): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      id: `memory-${this.memories.length + 1}`,
      text,
      createdAt: Date.now(),
      scope: options.scope,
      namespace: options.namespace
    };
    this.memories.push(memory);
    return memory;
  }

  async list(filter?: MemoryListFilter): Promise<readonly MemoryEntry[]> {
    if (!filter) {
      return this.memories;
    }
    return this.memories.filter((memory) => !filter.scope || memory.scope === filter.scope);
  }

  async update(id: string, text: string, options: MemoryWriteOptions = {}): Promise<MemoryEntry | undefined> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return undefined;
    }
    const updated: MemoryEntry = {
      ...this.memories[index],
      text,
      scope: options.scope,
      namespace: options.namespace
    };
    this.memories[index] = updated;
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return false;
    }
    this.memories.splice(index, 1);
    return true;
  }

  async clear(): Promise<void> {
    this.memories.splice(0, this.memories.length);
  }
}

export interface ControllerHarness {
  readonly controller: AgentController;
  readonly provider: ScriptedLlmProvider;
  readonly workspace: FakeWorkspace;
  readonly diff: FakeDiffService;
  readonly terminal: FakeTerminalRunner;
  readonly codeIntel: FakeCodeIntelPort;
  readonly memory: FakeMemoryStore;
  readonly events: AgentUiEvent[];
}

export interface ControllerHarnessOptions {
  readonly mode: AgentMode;
  readonly responses: readonly ScriptedLlmResponse[];
  readonly files?: Readonly<Record<string, string>>;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly permissionMode?: PermissionMode;
  readonly contextLimits?: ContextLimits;
}

export function createControllerHarness(options: ControllerHarnessOptions): ControllerHarness {
  const provider = new ScriptedLlmProvider(options.responses);
  const workspace = new FakeWorkspace(options.files);
  const diff = new FakeDiffService(workspace);
  const terminal = new FakeTerminalRunner();
  const codeIntel = new FakeCodeIntelPort();
  const notebooks = new FakeNotebookPort();
  const memory = new FakeMemoryStore();
  const permissionPolicy: PermissionPolicy = { mode: options.permissionMode ?? "smart", rules: [] };
  const contextLimits = options.contextLimits ?? { maxFiles: 12, maxBytes: 64000 };
  const config = {
    getActiveProfile: async () => fakeProfile,
    getNetworkPolicy: () => ({ allowlist: [] }),
    getAgentMode: () => options.mode,
    getPermissionPolicy: () => permissionPolicy,
    getMcpServers: () => options.mcpServers ?? [],
    getConfiguredModel: () => fakeProfile.defaultModel ?? "",
    getContextLimits: () => contextLimits,
    getCommandTimeoutSeconds: () => 10,
    getCommandOutputLimitBytes: () => 12000,
    getActiveProfileId: () => fakeProfile.id,
    getProfiles: () => [fakeProfile]
  } as unknown as CodeForgeConfigService;
  const events: AgentUiEvent[] = [];
  const controller = new AgentController(
    config,
    workspace,
    terminal as unknown as TerminalRunner,
    diff as unknown as DiffService,
    undefined,
    memory,
    codeIntel,
    notebooks,
    () => provider
  );
  controller.onEvent((event) => events.push(event));
  return { controller, provider, workspace, diff, terminal, codeIntel, memory, events };
}

export async function waitForEvent(events: readonly AgentUiEvent[], predicate: (event: AgentUiEvent) => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (events.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for event.");
}

const fakeProfile: ProviderProfile = {
  id: "fake-profile",
  label: "Fake Provider",
  baseUrl: "http://127.0.0.1:1",
  defaultModel: "fake-model"
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globMatches(pattern: string | undefined, path: string): boolean {
  if (!pattern || pattern === "**/*" || pattern === "*") {
    return true;
  }
  const normalized = normalizePath(path);
  return new RegExp(`^${globToRegexSource(normalizePath(pattern))}$`).test(normalized);
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const current = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (current === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (current === "*") {
      source += "[^/]*";
    } else if (current === "?") {
      source += "[^/]";
    } else {
      source += current.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}
