import type { CodeForgeTool } from "../toolRegistry";
import { invalidToolType, optionalString, parseNotebookCellKind, validateWorkspacePath } from "../toolValidation";

export const notebookTools: readonly CodeForgeTool[] = [
  {
    name: "notebook_read",
    description: "Read cells from a VS Code notebook in the current workspace.",
    searchHint: "read jupyter notebook",
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
      return typeof input.path === "string" ? { type: "notebook_read", path: input.path, reason: optionalString(input.reason) } : undefined;
    },
    validate(action) {
      return action.type === "notebook_read" ? validateWorkspacePath(action.path) : invalidToolType(action, "notebook_read");
    },
    summarize(action) {
      return action.type === "notebook_read" ? `Read notebook ${action.path}` : "Read notebook";
    }
  },
  {
    name: "notebook_edit_cell",
    description: "Replace one cell in a VS Code notebook after approval.",
    searchHint: "edit jupyter notebook",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        index: { type: "number" },
        content: { type: "string" },
        language: { type: "string" },
        kind: { type: "string", enum: ["code", "markdown"] },
        reason: { type: "string" }
      },
      required: ["path", "index", "content"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.path === "string" && typeof input.index === "number" && typeof input.content === "string"
        ? {
          type: "notebook_edit_cell",
          path: input.path,
          index: Math.max(0, Math.floor(input.index)),
          content: input.content,
          language: optionalString(input.language),
          kind: parseNotebookCellKind(input.kind),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "notebook_edit_cell") {
        return invalidToolType(action, "notebook_edit_cell");
      }
      const path = validateWorkspacePath(action.path);
      if (!path.ok) {
        return path;
      }
      if (!Number.isInteger(action.index) || action.index < 0) {
        return { ok: false, message: "Notebook cell index must be a zero-based non-negative integer." };
      }
      if (Buffer.byteLength(action.content, "utf8") > 2_000_000) {
        return { ok: false, message: "Notebook cell content is too large." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "notebook_edit_cell" ? `Edit notebook ${action.path} cell ${action.index}` : "Edit notebook cell";
    }
  },
];
