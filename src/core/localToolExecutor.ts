import { SearchResult, WorkspaceDiagnostic, WorkspacePort } from "./types";
import { isLocalReadOnlyAction, ToolInvocation, toolSummary, validateAction } from "./toolRegistry";

export type LocalToolStatus = "queued" | "running" | "completed" | "failed";

export interface LocalToolProgress {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: LocalToolStatus;
  readonly readOnly: boolean;
}

export interface LocalToolResult {
  readonly invocation: ToolInvocation;
  readonly content: string;
  readonly isError: boolean;
}

export interface LocalToolExecutorOptions {
  readonly workspace: WorkspacePort;
  readonly readFileMaxBytes: number;
  readonly searchLimit: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: LocalToolProgress) => void;
}

export async function executeLocalReadOnlyTools(
  invocations: readonly ToolInvocation[],
  options: LocalToolExecutorOptions
): Promise<readonly LocalToolResult[]> {
  for (const invocation of invocations) {
    options.onProgress?.(progressFor(invocation, "queued"));
  }

  const results = await Promise.all(invocations.map((invocation) => executeLocalReadOnlyTool(invocation, options)));
  return results;
}

async function executeLocalReadOnlyTool(invocation: ToolInvocation, options: LocalToolExecutorOptions): Promise<LocalToolResult> {
  options.onProgress?.(progressFor(invocation, "running"));
  const validation = validateAction(invocation.action);
  if (!validation.ok) {
    const content = formatToolError(validation.message ?? "Tool input failed validation.");
    options.onProgress?.(progressFor(invocation, "failed"));
    return { invocation, content, isError: true };
  }

  if (!isLocalReadOnlyAction(invocation.action)) {
    const content = formatToolError(`${invocation.action.type} is not a local read-only tool.`);
    options.onProgress?.(progressFor(invocation, "failed"));
    return { invocation, content, isError: true };
  }

  try {
    if (options.signal?.aborted) {
      throw new Error("Tool execution was cancelled.");
    }

    if (invocation.action.type === "read_file") {
      const content = await options.workspace.readTextFile(invocation.action.path, options.readFileMaxBytes, options.signal);
      const result = `read_file ${invocation.action.path}\n\n${content}`;
      options.onProgress?.(progressFor(invocation, "completed"));
      return { invocation, content: result, isError: false };
    }

    if (invocation.action.type === "list_files") {
      const files = await options.workspace.listFiles(invocation.action.pattern, limitFor(invocation.action.limit, options.searchLimit), options.signal);
      const result = `list_files${invocation.action.pattern ? ` ${invocation.action.pattern}` : ""}\n\n${formatFileList(files)}`;
      options.onProgress?.(progressFor(invocation, "completed"));
      return { invocation, content: result, isError: false };
    }

    if (invocation.action.type === "glob_files") {
      const files = await options.workspace.globFiles(invocation.action.pattern, limitFor(invocation.action.limit, options.searchLimit), options.signal);
      const result = `glob_files ${invocation.action.pattern}\n\n${formatFileList(files)}`;
      options.onProgress?.(progressFor(invocation, "completed"));
      return { invocation, content: result, isError: false };
    }

    if (invocation.action.type === "list_diagnostics") {
      const diagnostics = await options.workspace.getDiagnostics(invocation.action.path, limitFor(invocation.action.limit, options.searchLimit), options.signal);
      const result = `list_diagnostics${invocation.action.path ? ` ${invocation.action.path}` : ""}\n\n${formatDiagnostics(diagnostics)}`;
      options.onProgress?.(progressFor(invocation, "completed"));
      return { invocation, content: result, isError: false };
    }

    const results = invocation.action.type === "grep_text"
      ? await options.workspace.grepText(invocation.action.query, invocation.action.include, limitFor(invocation.action.limit, options.searchLimit), options.signal)
      : await options.workspace.searchText(invocation.action.query, options.searchLimit, options.signal);
    const result = `${invocation.action.type} ${invocation.action.query}\n\n${formatSearchResults(results)}`;
    options.onProgress?.(progressFor(invocation, "completed"));
    return { invocation, content: result, isError: false };
  } catch (error) {
    const content = formatToolError(error instanceof Error ? error.message : String(error));
    options.onProgress?.(progressFor(invocation, "failed"));
    return { invocation, content, isError: true };
  }
}

function progressFor(invocation: ToolInvocation, status: LocalToolStatus): LocalToolProgress {
  return {
    id: invocation.id,
    name: invocation.action.type,
    summary: toolSummary(invocation.action),
    status,
    readOnly: true
  };
}

function formatSearchResults(results: readonly SearchResult[]): string {
  if (results.length === 0) {
    return "No matches.";
  }
  return results.map((item) => `${item.path}:${item.line}: ${item.preview}`).join("\n");
}

function formatFileList(files: readonly string[]): string {
  return files.length > 0 ? files.join("\n") : "No files found.";
}

function formatDiagnostics(diagnostics: readonly WorkspaceDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.";
  }
  return diagnostics.map((item) => {
    const source = item.source ? ` ${item.source}` : "";
    const code = item.code ? ` ${item.code}` : "";
    return `${item.path}:${item.line}:${item.character}: ${item.severity}${source}${code}: ${item.message}`;
  }).join("\n");
}

function limitFor(actionLimit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(1000, actionLimit ?? fallback));
}

function formatToolError(message: string): string {
  return `<tool_use_error>Error: ${message}</tool_use_error>`;
}
