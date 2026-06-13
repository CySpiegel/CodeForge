import type { CodeForgeTool } from "../toolRegistry";
import { GitAction } from "../types";
import { classifyShellCommand } from "../shellSemantics";
import { invalidToolType, optionalString, validateWorkspacePath } from "../toolValidation";

const gitOperations: readonly GitAction["operation"][] = ["status", "diff", "log", "show", "branch"];

export const commandTools: readonly CodeForgeTool[] = [
  {
    name: "run_command",
    description: "Request approval to run a shell command in the current workspace.",
    searchHint: "run shell command",
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
    name: "git",
    description: "Read-only git inspection of the open repo: status, diff (add args '--cached' for staged), log, show <ref>, or branch list. Use this to review uncommitted changes before editing or to write a commit message. To actually commit or stage, propose a `git commit`/`git add` through run_command (approval-gated).",
    searchHint: "inspect git status, diff, log, branches",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["status", "diff", "log", "show", "branch"] },
        args: { type: "string", description: "Optional: a ref, repo-relative path, or safe flag (e.g. --cached, --stat, --name-only, -n <count>)." },
        reason: { type: "string" }
      },
      required: ["operation"],
      additionalProperties: false
    },
    parse(input) {
      const operation = optionalString(input.operation);
      if (!operation || !gitOperations.includes(operation as GitAction["operation"])) {
        return undefined;
      }
      return {
        type: "git",
        operation: operation as GitAction["operation"],
        args: optionalString(input.args),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "git") {
        return invalidToolType(action, "git");
      }
      if (!gitOperations.includes(action.operation)) {
        return { ok: false, message: `git operation must be one of: ${gitOperations.join(", ")}.` };
      }
      if (action.args && (action.args.length > 200 || action.args.includes("\0"))) {
        return { ok: false, message: "git args is invalid (too long or contains NUL)." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "git" ? `git ${action.operation}${action.args ? ` ${action.args}` : ""}` : "git";
    }
  },
];
