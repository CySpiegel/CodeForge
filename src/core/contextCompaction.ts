import { estimateMessagesBytes } from "./contextUsage";
import { ChatMessage } from "./types";

export interface ToolResultCompactionOptions {
  readonly maxBytes: number;
  readonly targetRatio?: number;
  readonly triggerRatio?: number;
  readonly keepRecentMessages?: number;
  readonly minToolResultBytes?: number;
}

export interface ToolResultCompactionResult {
  readonly messages: readonly ChatMessage[];
  readonly compactedCount: number;
}

const localToolPrefix = "CodeForge local tool result:\n\n";

export function compactOldToolResults(messages: readonly ChatMessage[], options: ToolResultCompactionOptions): ToolResultCompactionResult {
  const maxBytes = Math.max(1, options.maxBytes);
  const triggerBytes = maxBytes * (options.triggerRatio ?? 0.85);
  if (estimateMessagesBytes(messages) <= triggerBytes) {
    return { messages, compactedCount: 0 };
  }

  const targetBytes = maxBytes * (options.targetRatio ?? 0.7);
  const keepRecentMessages = options.keepRecentMessages ?? 8;
  const minToolResultBytes = options.minToolResultBytes ?? 4000;
  const next = [...messages];
  let compactedCount = 0;

  for (let index = 0; index < next.length - keepRecentMessages && estimateMessagesBytes(next) > targetBytes; index++) {
    const message = next[index];
    if (!isToolResultMessage(message) || Buffer.byteLength(message.content, "utf8") < minToolResultBytes || isAlreadyCompacted(message.content)) {
      continue;
    }

    next[index] = {
      ...message,
      content: compactToolResultContent(message.content)
    };
    compactedCount++;
  }

  return compactedCount > 0 ? { messages: next, compactedCount } : { messages, compactedCount: 0 };
}

export function compactToolResultContent(content: string): string {
  const body = content.startsWith(localToolPrefix) ? content.slice(localToolPrefix.length) : content;
  const lines = body.split(/\r?\n/);
  const preserved = new Set<string>();
  for (const line of lines.slice(0, 12)) {
    if (line.trim()) {
      preserved.add(line.slice(0, 500));
    }
  }
  for (const line of lines) {
    if (preserved.size >= 40) {
      break;
    }
    if (shouldPreserveToolLine(line)) {
      preserved.add(line.slice(0, 500));
    }
  }

  const summary = [
    "[CodeForge compacted this older tool result deterministically to preserve context budget.]",
    `Original size: ${Buffer.byteLength(content, "utf8")} bytes.`,
    "",
    ...preserved
  ].join("\n");

  return content.startsWith(localToolPrefix) ? `${localToolPrefix}${summary}` : summary;
}

function isToolResultMessage(message: ChatMessage): boolean {
  return message.role === "tool" || message.content.startsWith(localToolPrefix);
}

function isAlreadyCompacted(content: string): boolean {
  return content.includes("[CodeForge compacted this older tool result deterministically");
}

function shouldPreserveToolLine(line: string): boolean {
  const trimmed = line.trim();
  return /^Status:/i.test(trimmed)
    || /^STD(ERR|OUT):/i.test(trimmed)
    || /(?:^|\s)(?:[\w.-]+\/)+[\w.@-]+\.[A-Za-z0-9]+(?::\d+)?/.test(trimmed)
    || /(?:Applied changes|Wrote|Edited|User rejected|Error:)/i.test(trimmed);
}
