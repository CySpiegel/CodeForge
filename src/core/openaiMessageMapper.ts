import { ChatMessage, ToolDefinition } from "./types";
import { sanitizeToolArgumentsJson } from "./openaiToolArgs";

// Translate CodeForge chat/tool types into the OpenAI Chat Completions wire format, and repair the
// assistant↔tool message pairing before a request so the API never sees an orphaned or duplicated
// tool call. The OpenAiCompatibleProvider class owns the request/stream lifecycle and calls in here.

export function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? message.name ?? "tool"
    };
  }

  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {})
  };

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: sanitizeToolArgumentsJson(toolCall.argumentsJson)
      }
    }));
  }

  return result;
}

export function toOpenAiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

export function ensureOpenAiToolResultPairing(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const repaired: ChatMessage[] = [];
  const seenToolCallIds = new Set<string>();
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      index++;
      continue;
    }

    if (message.role === "tool") {
      index++;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) {
      repaired.push(message);
      index++;
      continue;
    }

    const toolCalls = message.toolCalls.filter((toolCall) => {
      if (seenToolCallIds.has(toolCall.id)) {
        return false;
      }
      seenToolCallIds.add(toolCall.id);
      return true;
    });

    if (toolCalls.length === 0) {
      repaired.push({
        role: "assistant",
        content: message.content.trim() ? message.content : "[Duplicate tool calls removed before OpenAI request.]"
      });
      index++;
      continue;
    }

    repaired.push(toolCalls.length === message.toolCalls.length ? message : { ...message, toolCalls });

    const toolMessages: ChatMessage[] = [];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === "tool") {
      toolMessages.push(messages[nextIndex]);
      nextIndex++;
    }

    const usedToolMessageIndexes = new Set<number>();
    for (const toolCall of toolCalls) {
      const matchingIndex = toolMessages.findIndex((toolMessage, toolMessageIndex) =>
        !usedToolMessageIndexes.has(toolMessageIndex) && toolMessage.toolCallId === toolCall.id
      );
      if (matchingIndex >= 0) {
        usedToolMessageIndexes.add(matchingIndex);
        repaired.push(toolMessages[matchingIndex]);
      } else {
        repaired.push({
          role: "tool",
          name: toolCall.name,
          toolCallId: toolCall.id,
          content: `<tool_use_error>Error: Tool call ${toolCall.name} was interrupted before CodeForge produced a result. Continue by inspecting current state before retrying.</tool_use_error>`
        });
      }
    }

    index = nextIndex;
  }

  return repaired;
}
