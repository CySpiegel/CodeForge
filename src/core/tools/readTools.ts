import type { CodeForgeTool } from "../toolRegistry";
import {
  invalidToolType,
  optionalPositiveInteger,
  optionalString,
  validateLimit,
  validateSearchQuery,
  validateWorkspaceGlob,
  validateWorkspacePath
} from "../toolValidation";

export const readTools: readonly CodeForgeTool[] = [
  {
    name: "list_files",
    description: "List files in the open repo folder. Use this before repo-wide reviews, architecture questions, or unfamiliar-code tasks to discover exact repo-relative paths.",
    searchHint: "discover repo files",
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
    description: "Fast file pattern matching in the open repo folder. Use this when you need files by name or extension, such as **/*.ts or src/**/*.tsx.",
    searchHint: "find files by glob pattern",
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
    description: "Read exact text contents from one repo file. Use this only for a specific repo-relative path from user text or prior list_files/glob_files/grep_text/search_text output. Do not guess paths.",
    searchHint: "read file contents",
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
    description: "Search plain text across the open repo folder. Prefer grep_text when you need an include glob, a bounded result count, or code-review evidence from matching files.",
    searchHint: "search repo text",
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
    description: "Search repo file contents with a query and optional include glob. Use this for codebase reviews, symbol hunting, API usage checks, TODO/error searches, and narrowing files before read_file.",
    searchHint: "search file contents",
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
    description: "List current VS Code diagnostics for the open repo folder or one repo file. Use this to inspect TypeScript, lint, language-server, and problem-panel evidence before suggesting fixes.",
    searchHint: "list vscode diagnostics",
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
];
