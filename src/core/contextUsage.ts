import { formatContextItem } from "./contextBuilder";
import { ChatMessage, ContextItem, TokenUsage } from "./types";

export interface ContextUsage {
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly percent: number;
  readonly label: string;
  readonly tokens: ContextTokenUsage;
  readonly breakdown: readonly ContextUsagePart[];
}

export interface ContextTokenUsage {
  readonly source: "actual" | "estimated";
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ContextUsagePart {
  readonly key: string;
  readonly label: string;
  readonly bytes: number;
  readonly percent: number;
}

export interface ContextUsageOptions {
  readonly actualTokenUsage?: TokenUsage;
  readonly maxTokens?: number;
}

export function buildContextUsage(messages: readonly ChatMessage[], maxBytes: number, contextItems: readonly ContextItem[] = [], options: ContextUsageOptions = {}): ContextUsage {
  const buckets = new Map<string, { label: string; bytes: number }>();

  for (const message of messages) {
    const toolCalls = message.toolCalls?.map((toolCall) => `${toolCall.id}:${toolCall.name}:${toolCall.argumentsJson}`).join("\n") ?? "";
    const content = message.content.startsWith("CodeForge workspace context:\n\n") && contextItems.length > 0
      ? "CodeForge workspace context:\n\n"
      : message.content;
    const bytes = Buffer.byteLength(`${message.role}\n${message.name ?? ""}\n${message.toolCallId ?? ""}\n${content}\n${toolCalls}\n`, "utf8");
    addBucket(buckets, bucketForMessage(message), bytes);
  }

  for (const item of contextItems) {
    addBucket(buckets, bucketForContextItem(item), Buffer.byteLength(formatContextItem(item), "utf8"));
  }

  const usedBytes = [...buckets.values()].reduce((total, part) => total + part.bytes, 0);
  const safeMax = Math.max(1, maxBytes);
  const estimatedUsedTokens = estimateTokens(usedBytes);
  const maxTokens = Math.max(1, options.maxTokens ?? estimateTokens(safeMax));
  const actualUsedTokens = options.actualTokenUsage?.totalTokens ?? options.actualTokenUsage?.promptTokens;
  const tokenUsage: ContextTokenUsage = {
    source: actualUsedTokens === undefined ? "estimated" : "actual",
    usedTokens: actualUsedTokens ?? estimatedUsedTokens,
    maxTokens,
    promptTokens: options.actualTokenUsage?.promptTokens,
    completionTokens: options.actualTokenUsage?.completionTokens,
    totalTokens: options.actualTokenUsage?.totalTokens
  };
  const percent = Math.min(100, Math.round((tokenUsage.usedTokens / tokenUsage.maxTokens) * 100));
  return {
    usedBytes,
    maxBytes: safeMax,
    percent,
    label: `${formatTokens(tokenUsage.usedTokens)} / ${formatTokens(tokenUsage.maxTokens)} tokens`,
    tokens: tokenUsage,
    breakdown: [...buckets.entries()].map(([key, part]) => ({
      key,
      label: part.label,
      bytes: part.bytes,
      percent: Math.min(100, Math.round((part.bytes / safeMax) * 100))
    })).filter((part) => part.bytes > 0)
  };
}

export function estimateMessagesBytes(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const toolCalls = message.toolCalls?.map((toolCall) => `${toolCall.id}:${toolCall.name}:${toolCall.argumentsJson}`).join("\n") ?? "";
    return total + Buffer.byteLength(`${message.role}\n${message.name ?? ""}\n${message.toolCallId ?? ""}\n${message.content}\n${toolCalls}\n`, "utf8");
  }, 0);
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

export function estimateTokens(bytes: number): number {
  return Math.max(0, Math.ceil(bytes / 4));
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function addBucket(buckets: Map<string, { label: string; bytes: number }>, bucket: { key: string; label: string }, bytes: number): void {
  const current = buckets.get(bucket.key);
  buckets.set(bucket.key, {
    label: bucket.label,
    bytes: (current?.bytes ?? 0) + bytes
  });
}

function bucketForMessage(message: ChatMessage): { key: string; label: string } {
  if (message.role === "system") {
    return { key: "system", label: "System and tool instructions" };
  }
  if (message.role === "assistant") {
    return { key: "assistant", label: "Assistant messages" };
  }
  if (message.role === "tool" || message.content.startsWith("CodeForge local tool result:\n\n")) {
    return { key: "toolResults", label: "Tool results" };
  }
  if (message.content.startsWith("CodeForge workspace context:\n\n")) {
    return { key: "workspaceContext", label: "Workspace context messages" };
  }
  return { key: "user", label: "User messages" };
}

function bucketForContextItem(item: ContextItem): { key: string; label: string } {
  switch (item.kind) {
    case "projectInstructions":
      return { key: "projectInstructions", label: "Project instructions" };
    case "memory":
      return { key: "memory", label: "Local memory" };
    case "mcpResource":
      return { key: "mcpResources", label: "MCP resources" };
    case "activeFile":
      return { key: "activeFile", label: "Active file" };
    case "selection":
      return { key: "selection", label: "Active selection" };
    case "openFile":
      return { key: "openFiles", label: "Open files" };
    case "fileTree":
      return { key: "fileTree", label: "Workspace file list" };
    case "file":
      return { key: "files", label: "Workspace files" };
  }
}
