import { ChatMessage } from "./types";

export interface ContextUsage {
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly percent: number;
  readonly label: string;
}

export function buildContextUsage(messages: readonly ChatMessage[], maxBytes: number, extraContent = ""): ContextUsage {
  const usedBytes = estimateMessagesBytes(messages) + Buffer.byteLength(extraContent, "utf8");
  const safeMax = Math.max(1, maxBytes);
  const percent = Math.min(100, Math.round((usedBytes / safeMax) * 100));
  return {
    usedBytes,
    maxBytes: safeMax,
    percent,
    label: `${formatBytes(usedBytes)} / ${formatBytes(safeMax)}`
  };
}

export function estimateMessagesBytes(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => {
    return total + Buffer.byteLength(`${message.role}\n${message.name ?? ""}\n${message.content}\n`, "utf8");
  }, 0);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}
