import type { CodeForgeTool } from "../toolRegistry";
import { parseUnifiedDiff } from "../unifiedDiff";
import { invalidToolType, optionalString, validatePatch, validateWorkspacePath } from "../toolValidation";

export const editTools: readonly CodeForgeTool[] = [
  {
    name: "propose_patch",
    description: "Propose a unified diff patch for user review.",
    searchHint: "preview unified diff",
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
    searchHint: "write full file",
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
    searchHint: "replace exact text",
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
    searchHint: "open diff preview",
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
];
