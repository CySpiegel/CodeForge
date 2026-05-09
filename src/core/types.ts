export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
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

export interface LlmProvider {
  readonly profile: ProviderProfile;
  streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
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

export interface ContextLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface ContextItem {
  readonly kind: "selection" | "openFile" | "fileTree" | "file";
  readonly label: string;
  readonly content: string;
}

export interface WorkspacePort {
  listTextFiles(limit: number, signal?: AbortSignal): Promise<readonly string[]>;
  readTextFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
  getOpenTextDocuments(maxBytesPerDocument: number): Promise<readonly ContextItem[]>;
  getActiveSelection(maxBytes: number): Promise<ContextItem | undefined>;
  searchText(query: string, limit: number, signal?: AbortSignal): Promise<readonly SearchResult[]>;
}

export interface SearchResult {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export type AgentAction =
  | ReadFileAction
  | SearchTextAction
  | ProposePatchAction
  | RunCommandAction;

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

export interface ProposePatchAction {
  readonly type: "propose_patch";
  readonly patch: string;
  readonly reason?: string;
}

export interface RunCommandAction {
  readonly type: "run_command";
  readonly command: string;
  readonly cwd?: string;
  readonly reason?: string;
}

export type ApprovalKind = "edit" | "command";

export interface ApprovalRequest {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly summary: string;
  readonly action: ProposePatchAction | RunCommandAction;
  readonly createdAt: number;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}
