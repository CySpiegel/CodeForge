// Shared helpers for tool-result text. Kept in one place so the controller, worker manager, and the
// learning coordinator format and detect tool errors identically (no copy-pasted variants).

import { errorMessage, isRecord } from "../core/guards";
// errorMessage is the shared core helper; re-exported so existing `from "./toolText"` importers keep working.
export { errorMessage };

export function toolError(message: string): string {
  return `<tool_use_error>Error: ${message}</tool_use_error>`;
}

export function isToolErrorText(text: string): boolean {
  return text.includes("<tool_use_error>");
}

// Keep only the first `limit` lines of a string (for compact inspector/log previews).
export function firstLines(value: string, limit: number): string {
  return value.split(/\r?\n/).slice(0, limit).join("\n");
}

// Parse a tool call's JSON arguments into a plain object, tolerating malformed input (returns {}).
export function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Heuristic: does this endpoint error mean the prompt exceeded the model's context window? Covers the
// common phrasings from vLLM, llama.cpp, LM Studio, LiteLLM, and OpenAI-style gateways.
export function isContextOverflowError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message) {
    return false;
  }
  return /context (length|window|size)/.test(message)
    || /maximum context/.test(message)
    || /exceed[a-z]*[^.]{0,24}context/.test(message)
    || /context[^.]{0,24}exceed/.test(message)
    || /too many tokens/.test(message)
    || /reduce the (length|input|number of tokens|prompt)/.test(message)
    || /prompt is too long/.test(message)
    || (/\b(400|413)\b/.test(message) && /\btokens?\b/.test(message));
}

// A tool error the model can recover from on its own (stale read, oldText mismatch, missing read) — the
// run loop feeds it back as a tool result instead of surfacing it as a hard failure.
export function isRecoverableEditPreflightError(error: unknown): boolean {
  if (isRecord(error) && error.modelRecoverableToolError === true) {
    return true;
  }
  const message = errorMessage(error);
  return /edit_file oldText (?:was not found|appears \d+ times)/.test(message)
    || /requires reading .* before modifying an existing file/.test(message)
    || /requires reading .* before modifying an existing notebook/.test(message)
    || /cannot modify .* because the file changed since it was read/.test(message);
}

// Tag an Error as model-recoverable so isRecoverableEditPreflightError() recognizes it downstream.
export function modelRecoverableToolError(message: string): Error & { readonly modelRecoverableToolError: true } {
  const error = new Error(message) as Error & { modelRecoverableToolError: true };
  Object.defineProperty(error, "modelRecoverableToolError", {
    value: true,
    enumerable: true
  });
  return error;
}

export function isMissingFileError(message: string): boolean {
  return /(?:no such file|not found|does not exist|enoent|unable to resolve nonexistent)/i.test(message);
}
