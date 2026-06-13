import { isRecord } from "./guards";
import { parseUnifiedDiff } from "./unifiedDiff";
import {
  AgentAction,
  CodeDefinitionAction,
  CodeForgeTaskStatus,
  CodeHoverAction,
  CodeReferencesAction,
  NotebookCellKindName,
  QuestionOption,
  UserQuestion
} from "./types";

// Input validation and parsing primitives shared by the tool-registry table. These belong to no single
// tool — they are the reusable building blocks each tool's parse()/validate() composes. The registry
// (`toolRegistry.ts`) imports them for the table and re-exports the externally-consumed ones.

export interface ToolValidationResult {
  readonly ok: boolean;
  readonly message?: string;
}

export function validateWorkspacePath(path: string): ToolValidationResult {
  if (!path.trim()) {
    return { ok: false, message: "Path must not be empty." };
  }
  if (path.includes("\0")) {
    return { ok: false, message: "Path must not contain NUL bytes." };
  }

  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("~")) {
    return { ok: false, message: `Refusing to access a home-relative path: ${path}` };
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, message: `Refusing to access path outside the open repo folder: ${path}` };
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
    return { ok: false, message: `Refusing to use a glob outside the open repo folder: ${pattern}` };
  }
  return { ok: true };
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numericOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

export function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

export function isSafeMcpName(value: string): boolean {
  return /^[A-Za-z0-9._/-]{1,160}$/.test(value) && !value.includes("..");
}

export function isSafeExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
}

export function isSafeWorkerId(value: string): boolean {
  return /^worker-\d+-[a-f0-9]+$/i.test(value);
}

export function parseQuestions(value: unknown): readonly UserQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item): UserQuestion | undefined => {
    if (!isRecord(item) || typeof item.question !== "string" || typeof item.header !== "string" || !Array.isArray(item.options)) {
      return undefined;
    }
    const options = item.options.map((option): QuestionOption | undefined => {
      if (!isRecord(option) || typeof option.label !== "string" || typeof option.description !== "string") {
        return undefined;
      }
      const parsed: QuestionOption = {
        label: option.label,
        description: option.description
      };
      const preview = optionalString(option.preview);
      return preview === undefined ? parsed : { ...parsed, preview };
    }).filter((option): option is QuestionOption => Boolean(option));
    const question: UserQuestion = {
      question: item.question,
      header: item.header,
      options
    };
    return typeof item.multiSelect === "boolean" ? { ...question, multiSelect: item.multiSelect } : question;
  }).filter((question): question is UserQuestion => Boolean(question));
}

export function parseTaskStatus(value: unknown): CodeForgeTaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "blocked" || value === "completed" || value === "cancelled"
    ? value
    : undefined;
}

export function parseNotebookCellKind(value: unknown): NotebookCellKindName | undefined {
  return value === "code" || value === "markdown" ? value : undefined;
}

export function validateTaskSubject(subject: string): ToolValidationResult | undefined {
  const trimmed = subject.trim();
  if (!trimmed) {
    return { ok: false, message: "Task subject must not be empty." };
  }
  if (trimmed.length > 240) {
    return { ok: false, message: "Task subject must be 240 characters or fewer." };
  }
  return undefined;
}

export function validateTaskId(taskId: string): ToolValidationResult {
  return /^task-\d+-[a-f0-9]+$/i.test(taskId)
    ? { ok: true }
    : { ok: false, message: "Task id is invalid." };
}

export function validateTaskIds(taskIds: readonly string[] | undefined): ToolValidationResult | undefined {
  if (!taskIds) {
    return undefined;
  }
  for (const taskId of taskIds) {
    const result = validateTaskId(taskId);
    if (!result.ok) {
      return result;
    }
  }
  return undefined;
}

export function codePositionParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      path: { type: "string" },
      line: { type: "number" },
      character: { type: "number" },
      reason: { type: "string" }
    },
    required: ["path", "line", "character"],
    additionalProperties: false
  };
}

export function parseCodePosition(type: CodeHoverAction["type"], input: Record<string, unknown>): CodeHoverAction | undefined;
export function parseCodePosition(type: CodeDefinitionAction["type"], input: Record<string, unknown>): CodeDefinitionAction | undefined;
export function parseCodePosition(type: CodeReferencesAction["type"], input: Record<string, unknown>): CodeReferencesAction | undefined;
export function parseCodePosition(type: CodeHoverAction["type"] | CodeDefinitionAction["type"] | CodeReferencesAction["type"], input: Record<string, unknown>): CodeHoverAction | CodeDefinitionAction | CodeReferencesAction | undefined {
  if (typeof input.path !== "string" || typeof input.line !== "number" || typeof input.character !== "number") {
    return undefined;
  }
  const line = Math.max(1, Math.floor(input.line));
  const character = Math.max(1, Math.floor(input.character));
  const reason = optionalString(input.reason);
  if (type === "code_hover") {
    return { type, path: input.path, line, character, reason };
  }
  if (type === "code_definition") {
    return { type, path: input.path, line, character, reason };
  }
  return { type, path: input.path, line, character, includeDeclaration: undefined, reason };
}

export function validateCodePosition(action: CodeHoverAction | CodeDefinitionAction | CodeReferencesAction): ToolValidationResult {
  const path = validateWorkspacePath(action.path);
  if (!path.ok) {
    return path;
  }
  if (!Number.isInteger(action.line) || action.line < 1) {
    return { ok: false, message: "Line must be a 1-based positive integer." };
  }
  if (!Number.isInteger(action.character) || action.character < 1) {
    return { ok: false, message: "Character must be a 1-based positive integer." };
  }
  return { ok: true };
}

export function validateSearchQuery(query: string): ToolValidationResult {
  if (!query.trim()) {
    return { ok: false, message: "Search query must not be empty." };
  }
  if (query.length > 500) {
    return { ok: false, message: "Search query is too long." };
  }
  return { ok: true };
}

export function validateLimit(limit: number | undefined): ToolValidationResult {
  if (limit === undefined) {
    return { ok: true };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, message: "Limit must be an integer between 1 and 1000." };
  }
  return { ok: true };
}

export function validatePatch(patch: string): ToolValidationResult {
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

export function invalidToolType(action: AgentAction, expected: AgentAction["type"]): ToolValidationResult {
  return { ok: false, message: `Expected ${expected}, received ${action.type}.` };
}
