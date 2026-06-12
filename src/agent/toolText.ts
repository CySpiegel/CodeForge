// Shared helpers for tool-result text. Kept in one place so the controller, worker manager, and the
// learning coordinator format and detect tool errors identically (no copy-pasted variants).

export function toolError(message: string): string {
  return `<tool_use_error>Error: ${message}</tool_use_error>`;
}

export function isToolErrorText(text: string): boolean {
  return text.includes("<tool_use_error>");
}

// Extract a human-readable message from any thrown value.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
