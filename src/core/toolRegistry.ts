import { parseUnifiedDiff } from "./unifiedDiff";
import { classifyShellCommand } from "./shellSemantics";
import {
  AgentAction,
  EditFileAction,
  GlobFilesAction,
  GrepTextAction,
  ListDiagnosticsAction,
  ListFilesAction,
  McpCallToolAction,
  ProposePatchAction,
  ReadFileAction,
  RunCommandAction,
  SearchTextAction,
  ToolDefinition,
  WriteFileAction
} from "./types";

export type ToolRisk = "read" | "search" | "edit" | "command";

export interface ToolValidationResult {
  readonly ok: boolean;
  readonly message?: string;
}

export interface CodeForgeTool {
  readonly name: AgentAction["type"];
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: ToolRisk;
  readonly concurrencySafe: boolean;
  readonly requiresApproval: boolean;
  parse(input: Record<string, unknown>): AgentAction | undefined;
  validate(action: AgentAction): ToolValidationResult;
  summarize(action: AgentAction): string;
}

export interface ToolInvocation {
  readonly id: string;
  readonly action: AgentAction;
  readonly source: "native" | "json";
  readonly toolCallId?: string;
}

export const codeForgeTools: readonly CodeForgeTool[] = [
  {
    name: "list_files",
    description: "List bounded workspace files using VS Code workspace APIs.",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return {
        type: "list_files",
        pattern: optionalString(input.pattern),
        limit: optionalPositiveInteger(input.limit),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "list_files") {
        return invalidToolType(action, "list_files");
      }
      if (action.pattern) {
        return validateWorkspaceGlob(action.pattern);
      }
      return validateLimit(action.limit);
    },
    summarize(action) {
      return action.type === "list_files" ? `List files${action.pattern ? ` matching ${action.pattern}` : ""}` : "List files";
    }
  },
  {
    name: "glob_files",
    description: "Find workspace files matching a glob pattern using VS Code workspace APIs.",
    risk: "search",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.pattern === "string"
        ? {
          type: "glob_files",
          pattern: input.pattern,
          limit: optionalPositiveInteger(input.limit),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "glob_files") {
        return invalidToolType(action, "glob_files");
      }
      const pattern = validateWorkspaceGlob(action.pattern);
      return pattern.ok ? validateLimit(action.limit) : pattern;
    },
    summarize(action) {
      return action.type === "glob_files" ? `Find files matching ${action.pattern}` : "Find files";
    }
  },
  {
    name: "read_file",
    description: "Read a bounded text file from the current workspace.",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string" }
      },
      required: ["path"],
      additionalProperties: false
    },
    parse(input) {
      const reason = optionalString(input.reason);
      return typeof input.path === "string" ? { type: "read_file", path: input.path, reason } : undefined;
    },
    validate(action) {
      if (action.type !== "read_file") {
        return invalidToolType(action, "read_file");
      }
      return validateWorkspacePath(action.path);
    },
    summarize(action) {
      return action.type === "read_file" ? `Read ${action.path}` : "Read file";
    }
  },
  {
    name: "search_text",
    description: "Search text in the current workspace. Prefer grep_text when you need an include glob.",
    risk: "search",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        reason: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    parse(input) {
      const reason = optionalString(input.reason);
      return typeof input.query === "string" ? { type: "search_text", query: input.query, reason } : undefined;
    },
    validate(action) {
      if (action.type !== "search_text") {
        return invalidToolType(action, "search_text");
      }
      if (!action.query.trim()) {
        return { ok: false, message: "Search query must not be empty." };
      }
      if (action.query.length > 500) {
        return { ok: false, message: "Search query is too long." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "search_text" ? `Search for ${action.query}` : "Search text";
    }
  },
  {
    name: "grep_text",
    description: "Search workspace file contents with an optional include glob using VS Code workspace APIs.",
    risk: "search",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        include: { type: "string" },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.query === "string"
        ? {
          type: "grep_text",
          query: input.query,
          include: optionalString(input.include),
          limit: optionalPositiveInteger(input.limit),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "grep_text") {
        return invalidToolType(action, "grep_text");
      }
      const query = validateSearchQuery(action.query);
      if (!query.ok) {
        return query;
      }
      if (action.include) {
        const include = validateWorkspaceGlob(action.include);
        if (!include.ok) {
          return include;
        }
      }
      return validateLimit(action.limit);
    },
    summarize(action) {
      return action.type === "grep_text" ? `Search for ${action.query}${action.include ? ` in ${action.include}` : ""}` : "Search text";
    }
  },
  {
    name: "list_diagnostics",
    description: "List current VS Code diagnostics for the workspace or one workspace file.",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return {
        type: "list_diagnostics",
        path: optionalString(input.path),
        limit: optionalPositiveInteger(input.limit),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "list_diagnostics") {
        return invalidToolType(action, "list_diagnostics");
      }
      const limit = validateLimit(action.limit);
      if (!limit.ok) {
        return limit;
      }
      return action.path ? validateWorkspacePath(action.path) : { ok: true };
    },
    summarize(action) {
      return action.type === "list_diagnostics" ? `List diagnostics${action.path ? ` for ${action.path}` : ""}` : "List diagnostics";
    }
  },
  {
    name: "propose_patch",
    description: "Propose a unified diff patch for user review.",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        reason: { type: "string" }
      },
      required: ["patch"],
      additionalProperties: false
    },
    parse(input) {
      const reason = optionalString(input.reason);
      return typeof input.patch === "string" ? { type: "propose_patch", patch: input.patch, reason } : undefined;
    },
    validate(action) {
      if (action.type !== "propose_patch") {
        return invalidToolType(action, "propose_patch");
      }
      try {
        const patches = parseUnifiedDiff(action.patch);
        if (patches.length === 0) {
          return { ok: false, message: "Patch must contain at least one file diff." };
        }
        for (const patch of patches) {
          const oldPathResult = patch.oldPath === "/dev/null" ? { ok: true } : validateWorkspacePath(patch.oldPath);
          const newPathResult = patch.newPath === "/dev/null" ? { ok: true } : validateWorkspacePath(patch.newPath);
          if (!oldPathResult.ok) {
            return oldPathResult;
          }
          if (!newPathResult.ok) {
            return newPathResult;
          }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    summarize(action) {
      if (action.type !== "propose_patch") {
        return "Apply proposed patch";
      }
      const patches = parseUnifiedDiff(action.patch);
      const paths = patches.map((patch) => patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath);
      return `Apply edits to ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
    }
  },
  {
    name: "write_file",
    description: "Write a full text file after permission approval and VS Code diff preview.",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        reason: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.path === "string" && typeof input.content === "string"
        ? { type: "write_file", path: input.path, content: input.content, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "write_file") {
        return invalidToolType(action, "write_file");
      }
      const path = validateWorkspacePath(action.path);
      if (!path.ok) {
        return path;
      }
      if (Buffer.byteLength(action.content, "utf8") > 2_000_000) {
        return { ok: false, message: "File content is too large to write in one tool call." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "write_file" ? `Write ${action.path}` : "Write file";
    }
  },
  {
    name: "edit_file",
    description: "Replace exact text in a workspace file after permission approval and VS Code diff preview.",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.path === "string" && typeof input.oldText === "string" && typeof input.newText === "string"
        ? {
          type: "edit_file",
          path: input.path,
          oldText: input.oldText,
          newText: input.newText,
          replaceAll: typeof input.replaceAll === "boolean" ? input.replaceAll : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "edit_file") {
        return invalidToolType(action, "edit_file");
      }
      const path = validateWorkspacePath(action.path);
      if (!path.ok) {
        return path;
      }
      if (!action.oldText) {
        return { ok: false, message: "oldText must not be empty for edit_file." };
      }
      if (action.oldText === action.newText) {
        return { ok: false, message: "oldText and newText are identical." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "edit_file" ? `Edit ${action.path}` : "Edit file";
    }
  },
  {
    name: "open_diff",
    description: "Open a VS Code diff preview for a unified diff without applying it.",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        reason: { type: "string" }
      },
      required: ["patch"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.patch === "string" ? { type: "open_diff", patch: input.patch, reason: optionalString(input.reason) } : undefined;
    },
    validate(action) {
      if (action.type !== "open_diff") {
        return invalidToolType(action, "open_diff");
      }
      return validatePatch(action.patch);
    },
    summarize() {
      return "Open diff preview";
    }
  },
  {
    name: "run_command",
    description: "Request approval to run a shell command in the current workspace.",
    risk: "command",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        reason: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    },
    parse(input) {
      const reason = optionalString(input.reason);
      return typeof input.command === "string"
        ? {
          type: "run_command",
          command: input.command,
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
          reason
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "run_command") {
        return invalidToolType(action, "run_command");
      }
      if (!action.command.trim()) {
        return { ok: false, message: "Command must not be empty." };
      }
      if (action.command.includes("\0")) {
        return { ok: false, message: "Command must not contain NUL bytes." };
      }
      if (action.command.length > 8000) {
        return { ok: false, message: "Command is too long." };
      }
      const semantics = classifyShellCommand(action.command);
      if (semantics.usesBackgroundExecution) {
        return { ok: false, message: "Background shell execution is not supported yet. Run commands in the foreground so CodeForge can stream, bound, and stop output." };
      }
      return action.cwd ? validateWorkspacePath(action.cwd) : { ok: true };
    },
    summarize(action) {
      return action.type === "run_command" ? action.command : "Run command";
    }
  },
  {
    name: "mcp_call_tool",
    description: "Call a tool on an explicitly configured local/on-prem MCP server after permission approval.",
    risk: "command",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
        reason: { type: "string" }
      },
      required: ["serverId", "toolName"],
      additionalProperties: false
    },
    parse(input) {
      const args = input.arguments;
      return typeof input.serverId === "string" && typeof input.toolName === "string"
        ? {
          type: "mcp_call_tool",
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: args === undefined ? undefined : isRecord(args) ? args : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "mcp_call_tool") {
        return invalidToolType(action, "mcp_call_tool");
      }
      if (!isSafeMcpName(action.serverId)) {
        return { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." };
      }
      if (!isSafeMcpName(action.toolName)) {
        return { ok: false, message: "MCP toolName must contain only letters, numbers, dots, slashes, underscores, or dashes." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_call_tool" ? `Call MCP ${action.serverId}/${action.toolName}` : "Call MCP tool";
    }
  }
];

export const toolDefinitions: readonly ToolDefinition[] = codeForgeTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
}));

export function findTool(name: string): CodeForgeTool | undefined {
  return codeForgeTools.find((tool) => tool.name === name);
}

export function parseAction(name: string, input: Record<string, unknown>): AgentAction | undefined {
  return findTool(name)?.parse(input);
}

export function validateAction(action: AgentAction): ToolValidationResult {
  return findTool(action.type)?.validate(action) ?? { ok: false, message: `Unknown tool: ${action.type}` };
}

export function isLocalReadOnlyAction(action: AgentAction): action is ListFilesAction | GlobFilesAction | ReadFileAction | SearchTextAction | GrepTextAction | ListDiagnosticsAction {
  const tool = findTool(action.type);
  return Boolean(tool && !tool.requiresApproval && tool.concurrencySafe);
}

export function isApprovalAction(action: AgentAction): action is ProposePatchAction | WriteFileAction | EditFileAction | RunCommandAction | McpCallToolAction {
  const tool = findTool(action.type);
  return Boolean(tool?.requiresApproval);
}

export function toolSummary(action: AgentAction): string {
  return findTool(action.type)?.summarize(action) ?? action.type;
}

export function validateWorkspacePath(path: string): ToolValidationResult {
  if (!path.trim()) {
    return { ok: false, message: "Path must not be empty." };
  }
  if (path.includes("\0")) {
    return { ok: false, message: "Path must not contain NUL bytes." };
  }

  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:/.test(normalized)) {
    return { ok: false, message: `Refusing to access an absolute path: ${path}` };
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, message: `Refusing to access path outside the workspace: ${path}` };
  }

  return { ok: true };
}

export function validateWorkspaceGlob(pattern: string): ToolValidationResult {
  if (!pattern.trim()) {
    return { ok: false, message: "Glob pattern must not be empty." };
  }
  if (pattern.includes("\0")) {
    return { ok: false, message: "Glob pattern must not contain NUL bytes." };
  }
  const normalized = pattern.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:/.test(normalized)) {
    return { ok: false, message: `Refusing to use an absolute glob pattern: ${pattern}` };
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, message: `Refusing to use a glob outside the workspace: ${pattern}` };
  }
  return { ok: true };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeMcpName(value: string): boolean {
  return /^[A-Za-z0-9._/-]{1,160}$/.test(value) && !value.includes("..");
}

function validateSearchQuery(query: string): ToolValidationResult {
  if (!query.trim()) {
    return { ok: false, message: "Search query must not be empty." };
  }
  if (query.length > 500) {
    return { ok: false, message: "Search query is too long." };
  }
  return { ok: true };
}

function validateLimit(limit: number | undefined): ToolValidationResult {
  if (limit === undefined) {
    return { ok: true };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, message: "Limit must be an integer between 1 and 1000." };
  }
  return { ok: true };
}

function validatePatch(patch: string): ToolValidationResult {
  try {
    const patches = parseUnifiedDiff(patch);
    if (patches.length === 0) {
      return { ok: false, message: "Patch must contain at least one file diff." };
    }
    for (const patchFile of patches) {
      const oldPathResult = patchFile.oldPath === "/dev/null" ? { ok: true } : validateWorkspacePath(patchFile.oldPath);
      const newPathResult = patchFile.newPath === "/dev/null" ? { ok: true } : validateWorkspacePath(patchFile.newPath);
      if (!oldPathResult.ok) {
        return oldPathResult;
      }
      if (!newPathResult.ok) {
        return newPathResult;
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function invalidToolType(action: AgentAction, expected: AgentAction["type"]): ToolValidationResult {
  return { ok: false, message: `Expected ${expected}, received ${action.type}.` };
}
