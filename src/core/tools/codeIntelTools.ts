import type { CodeForgeTool } from "../toolRegistry";
import { codePositionParameters, invalidToolType, optionalString, parseCodePosition, validateCodePosition, validateSearchQuery, validateWorkspacePath } from "../toolValidation";

export const codeIntelTools: readonly CodeForgeTool[] = [
  {
    name: "code_hover",
    description: "Use VS Code language services to read hover information at a workspace file position.",
    searchHint: "language server hover",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: codePositionParameters(),
    parse(input) {
      return parseCodePosition("code_hover", input);
    },
    validate(action) {
      return action.type === "code_hover" ? validateCodePosition(action) : invalidToolType(action, "code_hover");
    },
    summarize(action) {
      return action.type === "code_hover" ? `Read hover at ${action.path}:${action.line}:${action.character}` : "Read hover";
    }
  },
  {
    name: "code_definition",
    description: "Use VS Code language services to find definitions at a workspace file position.",
    searchHint: "language server definition",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: codePositionParameters(),
    parse(input) {
      return parseCodePosition("code_definition", input);
    },
    validate(action) {
      return action.type === "code_definition" ? validateCodePosition(action) : invalidToolType(action, "code_definition");
    },
    summarize(action) {
      return action.type === "code_definition" ? `Find definition at ${action.path}:${action.line}:${action.character}` : "Find definition";
    }
  },
  {
    name: "code_references",
    description: "Use VS Code language services to find references at a workspace file position.",
    searchHint: "language server references",
    risk: "search",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        includeDeclaration: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["path", "line", "character"],
      additionalProperties: false
    },
    parse(input) {
      const parsed = parseCodePosition("code_references", input);
      return parsed && parsed.type === "code_references"
        ? { ...parsed, includeDeclaration: typeof input.includeDeclaration === "boolean" ? input.includeDeclaration : undefined }
        : undefined;
    },
    validate(action) {
      return action.type === "code_references" ? validateCodePosition(action) : invalidToolType(action, "code_references");
    },
    summarize(action) {
      return action.type === "code_references" ? `Find references at ${action.path}:${action.line}:${action.character}` : "Find references";
    }
  },
  {
    name: "code_symbols",
    description: "Use VS Code language services to list document symbols for one file or workspace symbols matching a query.",
    searchHint: "language server symbols",
    risk: "search",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return {
        type: "code_symbols",
        path: optionalString(input.path),
        query: optionalString(input.query),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "code_symbols") {
        return invalidToolType(action, "code_symbols");
      }
      if (!action.path && !action.query) {
        return { ok: false, message: "code_symbols requires either path or query." };
      }
      return action.path ? validateWorkspacePath(action.path) : validateSearchQuery(action.query ?? "");
    },
    summarize(action) {
      return action.type === "code_symbols" ? `List code symbols${action.path ? ` in ${action.path}` : ` matching ${action.query}`}` : "List code symbols";
    }
  },
];
