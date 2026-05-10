export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface LlmRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly tools?: readonly ToolDefinition[];
  readonly signal?: AbortSignal;
}

export type LlmStreamEvent =
  | { readonly type: "content"; readonly text: string }
  | { readonly type: "toolCalls"; readonly toolCalls: readonly ToolCall[] }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "done" };

export interface TokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly modelListing: boolean;
  readonly nativeToolCalls: boolean;
}

export type OpenAiBackendKind = "openai-api" | "litellm" | "vllm" | "lmstudio";

export interface ModelInfo {
  readonly id: string;
  readonly type?: string;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly supportsReasoning?: boolean;
}

export interface OpenAiEndpointInspection {
  readonly backend: OpenAiBackendKind;
  readonly backendLabel: string;
  readonly models: readonly ModelInfo[];
}

export interface LlmProvider {
  readonly profile: ProviderProfile;
  streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  inspectEndpoint(signal?: AbortSignal): Promise<OpenAiEndpointInspection>;
  probeCapabilities(model: string, signal?: AbortSignal): Promise<ProviderCapabilities>;
}

export interface ProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly apiKeySecretName?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface NetworkPolicy {
  readonly allowlist: readonly string[];
}

export type AgentMode = "agent" | "ask" | "plan";
export type PermissionMode = "default" | "review" | "acceptEdits" | "readOnly" | "workspaceTrusted";
export type PermissionBehavior = "allow" | "ask" | "deny";
export type PermissionRuleKind = "tool" | "path" | "command" | "endpoint";
export type PermissionRuleScope = "session" | "workspace" | "user";

export interface PermissionRule {
  readonly kind: PermissionRuleKind;
  readonly pattern: string;
  readonly behavior: PermissionBehavior;
  readonly scope: PermissionRuleScope;
  readonly description?: string;
}

export interface PermissionPolicy {
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
}

export interface PermissionDecision {
  readonly behavior: PermissionBehavior;
  readonly source: "rule" | "mode" | "default";
  readonly reason: string;
  readonly rule?: PermissionRule;
}

export interface ContextLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface ContextItem {
  readonly kind: "activeFile" | "selection" | "openFile" | "fileTree" | "file" | "projectInstructions" | "memory";
  readonly label: string;
  readonly content: string;
}

export interface WorkspacePort {
  listTextFiles(limit: number, signal?: AbortSignal): Promise<readonly string[]>;
  listFiles(pattern: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly string[]>;
  globFiles(pattern: string, limit: number, signal?: AbortSignal): Promise<readonly string[]>;
  readTextFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
  getActiveTextDocument(maxBytes: number): Promise<ContextItem | undefined>;
  getOpenTextDocuments(maxBytesPerDocument: number): Promise<readonly ContextItem[]>;
  getActiveSelection(maxBytes: number): Promise<ContextItem | undefined>;
  searchText(query: string, limit: number, signal?: AbortSignal): Promise<readonly SearchResult[]>;
  grepText(query: string, include: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly SearchResult[]>;
  getDiagnostics(path: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly WorkspaceDiagnostic[]>;
}

export interface SearchResult {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface WorkspaceDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
}

export type AgentAction =
  | ListFilesAction
  | GlobFilesAction
  | ReadFileAction
  | SearchTextAction
  | GrepTextAction
  | ListDiagnosticsAction
  | ProposePatchAction
  | WriteFileAction
  | EditFileAction
  | OpenDiffAction
  | RunCommandAction;

export interface ListFilesAction {
  readonly type: "list_files";
  readonly pattern?: string;
  readonly limit?: number;
  readonly reason?: string;
}

export interface GlobFilesAction {
  readonly type: "glob_files";
  readonly pattern: string;
  readonly limit?: number;
  readonly reason?: string;
}

export interface ReadFileAction {
  readonly type: "read_file";
  readonly path: string;
  readonly reason?: string;
}

export interface SearchTextAction {
  readonly type: "search_text";
  readonly query: string;
  readonly reason?: string;
}

export interface GrepTextAction {
  readonly type: "grep_text";
  readonly query: string;
  readonly include?: string;
  readonly limit?: number;
  readonly reason?: string;
}

export interface ListDiagnosticsAction {
  readonly type: "list_diagnostics";
  readonly path?: string;
  readonly limit?: number;
  readonly reason?: string;
}

export interface ProposePatchAction {
  readonly type: "propose_patch";
  readonly patch: string;
  readonly reason?: string;
}

export interface WriteFileAction {
  readonly type: "write_file";
  readonly path: string;
  readonly content: string;
  readonly reason?: string;
}

export interface EditFileAction {
  readonly type: "edit_file";
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
  readonly reason?: string;
}

export interface OpenDiffAction {
  readonly type: "open_diff";
  readonly patch: string;
  readonly reason?: string;
}

export interface RunCommandAction {
  readonly type: "run_command";
  readonly command: string;
  readonly cwd?: string;
  readonly reason?: string;
}

export type ApprovalKind = "read" | "search" | "edit" | "preview" | "command";

export interface ApprovalRequest {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: string;
  readonly permissionReason?: string;
  readonly permissionSource?: PermissionDecision["source"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly action: AgentAction;
  readonly createdAt: number;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly outputLimitBytes: number;
  readonly cwd: string;
  readonly startedAt: number;
  readonly endedAt: number;
}
