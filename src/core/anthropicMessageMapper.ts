import { ensureOpenAiToolResultPairing } from "./openaiMessageMapper";
import { parseToolArguments } from "./openaiToolArgs";
import { ChatMessage, ToolDefinition } from "./types";

// Translate CodeForge's flat, OpenAI-style ChatMessage[] into the Anthropic Messages API shape. Three
// structural differences drive this file:
//   1. SYSTEM HOIST — a system prompt is a role:"system" ChatMessage in CodeForge, but Anthropic takes
//      it as a TOP-LEVEL `system` string and 400s on a system role inside `messages`. Compaction can
//      re-inject a system message at any index, so every system message is collected (not just [0]).
//   2. TOOL RESULTS MOVE INTO A USER TURN — CodeForge records each tool result as its own role:"tool"
//      message keyed by toolCallId; Anthropic needs them as {type:"tool_result"} blocks inside a USER
//      message, with all results for one assistant turn coalesced into a single user turn.
//   3. TOOL CALLS BECOME tool_use BLOCKS — an assistant turn's ToolCall list becomes {type:"tool_use"}
//      blocks whose `input` is a PARSED OBJECT (never the raw, possibly-truncated argument string).
// Orphaned/duplicate tool calls are repaired first by reusing ensureOpenAiToolResultPairing, which
// guarantees each assistant tool_use is immediately followed by a matching tool result.

export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface AnthropicRequestParts {
  readonly system?: string;
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicTool[];
}

export function toAnthropicRequest(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[]
): AnthropicRequestParts {
  const paired = ensureOpenAiToolResultPairing(messages);

  const systemParts: string[] = [];
  for (const message of paired) {
    if (message.role === "system" && message.content.trim()) {
      systemParts.push(message.content);
    }
  }

  const result: AnthropicMessage[] = [];
  let index = 0;
  while (index < paired.length) {
    const message = paired[index];
    if (!message || message.role === "system") {
      index++;
      continue;
    }

    if (message.role === "tool") {
      // Coalesce this run of consecutive tool results into ONE user message of tool_result blocks.
      const blocks: AnthropicToolResultBlock[] = [];
      while (index < paired.length && paired[index]?.role === "tool") {
        const toolMessage = paired[index];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMessage.toolCallId ?? toolMessage.name ?? "tool",
          content: toolMessage.content
        });
        index++;
      }
      result.push({ role: "user", content: blocks });
      continue;
    }

    if (message.role === "assistant") {
      result.push({ role: "assistant", content: toAssistantContent(message) });
      index++;
      continue;
    }

    result.push({ role: "user", content: message.content });
    index++;
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: ensureLeadingUser(result),
    ...(tools && tools.length > 0 ? { tools: tools.map(toAnthropicTool) } : {})
  };
}

export function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  const schema = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
  // Anthropic requires input_schema to be a JSON Schema object. CodeForge tool parameters already are
  // ({ type:"object", properties, required }); guard the type field defensively for hand-built tools.
  return {
    name: tool.name,
    description: tool.description,
    input_schema: "type" in schema ? schema : { type: "object", ...schema }
  };
}

function toAssistantContent(message: ChatMessage): string | readonly AnthropicContentBlock[] {
  if (!message.toolCalls || message.toolCalls.length === 0) {
    return message.content;
  }
  const blocks: AnthropicContentBlock[] = [];
  if (message.content.trim()) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.toolCalls) {
    const parsed = parseToolArguments(toolCall.argumentsJson);
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parsed.ok ? parsed.value : {}
    });
  }
  return blocks;
}

// Anthropic rejects a leading assistant message. If hoisting the system prompt (or resuming a
// transcript that begins mid-turn) left an assistant message first, prepend a minimal user turn so the
// conversation is well-formed.
function ensureLeadingUser(messages: readonly AnthropicMessage[]): readonly AnthropicMessage[] {
  if (messages.length === 0 || messages[0].role === "user") {
    return messages;
  }
  return [{ role: "user", content: "Continue." }, ...messages];
}
