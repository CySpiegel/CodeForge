// Generic, MCP-agnostic helpers shared by the MCP client facade and its transports. No MCP protocol
// types — pure utilities (JSON, truncation, abort plumbing, id/env sandboxing) kept in one place.

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("MCP request was cancelled.");
  }
}

export function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function requestId(): string {
  return `codeforge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

export async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

// Combine two abort signals into one that fires when either does (used to merge the per-request signal
// with a transport-level timeout). Returns the primary unchanged when there is no secondary.
export function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return controller.signal;
  }
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

// A minimal, sanitized environment for spawned stdio MCP servers: only an explicit allowlist of OS
// essentials passes through, so a server subprocess never inherits secrets from the editor's env.
export function mcpEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT"
  ];
  const env: NodeJS.ProcessEnv = {
    CODEFORGE: "1",
    NO_COLOR: "1"
  };
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
