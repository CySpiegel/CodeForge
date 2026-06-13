import { isRecord } from "./guards";
import { parseUnifiedDiff } from "./unifiedDiff";
import { classifyShellCommand } from "./shellSemantics";
import { FACT_FEEDBACK_SCHEMA, FACT_STORE_SCHEMA } from "./holographic/factTools";
import {
  AgentAction,
  AskUserQuestionAction,
  EditFileAction,
  GitAction,
  McpCallToolAction,
  NotebookEditCellAction,
  ProposePatchAction,
  RunCommandAction,
  SkillManageAction,
  FactStoreAction,
  ToolDefinition,
  WriteFileAction
} from "./types";
import {
  ToolValidationResult,
  codePositionParameters,
  invalidToolType,
  isSafeExtensionName,
  isSafeMcpName,
  isSafeWorkerId,
  numericOrUndefined,
  optionalPositiveInteger,
  optionalString,
  optionalStringArray,
  parseCodePosition,
  parseNotebookCellKind,
  parseQuestions,
  parseTaskStatus,
  validateCodePosition,
  validateLimit,
  validatePatch,
  validateSearchQuery,
  validateTaskId,
  validateTaskIds,
  validateTaskSubject,
  validateWorkspaceGlob,
  validateWorkspacePath
} from "./toolValidation";

export type ToolRisk = "read" | "search" | "automation" | "question" | "memory" | "state" | "service" | "edit" | "command";

// The validation primitives and the pure action-classification predicates now live in their own modules.
// These re-exports keep existing importers (e.g. agentController, vscodeWorkspace) getting them from here.
export type { ToolValidationResult };
export { validateWorkspacePath, validateWorkspaceGlob };
export {
  isReadOnlyAction,
  isLocalReadOnlyAction,
  isInternalAutomationAction,
  isInternalStateAction,
  isInternalReadAction
} from "./toolClassification";

const gitOperations: readonly GitAction["operation"][] = ["status", "diff", "log", "show", "branch"];

export interface CodeForgeTool {
  readonly name: AgentAction["type"];
  readonly description: string;
  readonly searchHint?: string;
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
  {
    name: "spawn_agent",
    description: "Launch a CodeForge built-in or workspace-local agent to investigate, review, verify, or implement a task.",
    searchHint: "delegate local agent work",
    risk: "automation",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        background: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.prompt === "string"
        ? {
          type: "spawn_agent",
          agent: optionalString(input.agent),
          prompt: input.prompt,
          description: optionalString(input.description),
          background: typeof input.background === "boolean" ? input.background : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "spawn_agent") {
        return invalidToolType(action, "spawn_agent");
      }
      if (!action.prompt.trim()) {
        return { ok: false, message: "Agent prompt must not be empty." };
      }
      if (action.prompt.length > 24000) {
        return { ok: false, message: "Agent prompt is too long." };
      }
      if (action.agent && !isSafeExtensionName(action.agent)) {
        return { ok: false, message: "Agent name must contain only letters, numbers, underscores, or dashes." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "spawn_agent" ? `Launch agent ${action.agent || "implement"}` : "Launch agent";
    }
  },
  {
    name: "worker_output",
    description: "Read a CodeForge worker/agent's status and transcript. Set wait=true to block until it finishes — spawn several agents, then read each back with wait=true to run them in parallel and join the results.",
    searchHint: "read worker transcript",
    risk: "automation",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string" },
        wait: { type: "boolean", description: "Block until the worker finishes before returning its transcript." },
        reason: { type: "string" }
      },
      required: ["workerId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.workerId === "string"
        ? { type: "worker_output", workerId: input.workerId, wait: input.wait === true, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "worker_output") {
        return invalidToolType(action, "worker_output");
      }
      return isSafeWorkerId(action.workerId)
        ? { ok: true }
        : { ok: false, message: "Worker id is invalid." };
    },
    summarize(action) {
      return action.type === "worker_output" ? `Read worker output ${action.workerId}` : "Read worker output";
    }
  },
  {
    name: "ask_user_question",
    description: "Pause the local model loop and ask the user one or more structured multiple-choice questions inside the VS Code extension.",
    searchHint: "ask user choice",
    risk: "question",
    concurrencySafe: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: { type: "string" },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                    preview: { type: "string" }
                  },
                  required: ["label", "description"],
                  additionalProperties: false
                }
              }
            },
            required: ["question", "header", "options"],
            additionalProperties: false
          }
        },
        reason: { type: "string" }
      },
      required: ["questions"],
      additionalProperties: false
    },
    parse(input) {
      const questions = parseQuestions(input.questions);
      return questions.length > 0
        ? { type: "ask_user_question", questions, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "ask_user_question") {
        return invalidToolType(action, "ask_user_question");
      }
      if (action.questions.length < 1 || action.questions.length > 4) {
        return { ok: false, message: "ask_user_question requires 1-4 questions." };
      }
      const seenQuestions = new Set<string>();
      for (const question of action.questions) {
        if (!question.question.trim() || !question.question.trim().endsWith("?")) {
          return { ok: false, message: "Each question must be non-empty and end with a question mark." };
        }
        if (!question.header.trim() || question.header.length > 18) {
          return { ok: false, message: "Each question header must be 1-18 characters." };
        }
        const normalizedQuestion = question.question.trim().toLowerCase();
        if (seenQuestions.has(normalizedQuestion)) {
          return { ok: false, message: "Question texts must be unique." };
        }
        seenQuestions.add(normalizedQuestion);
        if (question.options.length < 2 || question.options.length > 4) {
          return { ok: false, message: "Each question must have 2-4 options." };
        }
        const labels = new Set<string>();
        for (const option of question.options) {
          if (!option.label.trim() || !option.description.trim()) {
            return { ok: false, message: "Question option labels and descriptions must not be empty." };
          }
          if (option.label.length > 40) {
            return { ok: false, message: "Question option labels must be 40 characters or fewer." };
          }
          const normalizedLabel = option.label.trim().toLowerCase();
          if (labels.has(normalizedLabel)) {
            return { ok: false, message: "Option labels must be unique within a question." };
          }
          labels.add(normalizedLabel);
        }
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "ask_user_question" ? `Ask ${action.questions.length} user question(s)` : "Ask user question";
    }
  },
  {
    name: "tool_search",
    description: "Search CodeForge's deferred tool catalog and load matching tool schemas for the next model turn.",
    searchHint: "load deferred tool schema",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tool capability query, or select:tool_name to load an exact tool schema." },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.query === "string"
        ? {
          type: "tool_search",
          query: input.query,
          limit: optionalPositiveInteger(input.limit),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "tool_search") {
        return invalidToolType(action, "tool_search");
      }
      const query = action.query.trim();
      if (!query) {
        return { ok: false, message: "tool_search query must not be empty." };
      }
      if (query.length > 200) {
        return { ok: false, message: "tool_search query must be 200 characters or fewer." };
      }
      return validateLimit(action.limit);
    },
    summarize(action) {
      return action.type === "tool_search" ? `Search tools for ${action.query}` : "Search tools";
    }
  },
  {
    name: "tool_list",
    description: "List CodeForge model-facing tools, risks, approval requirements, and concurrency metadata.",
    searchHint: "list available tools",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return { type: "tool_list", reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "tool_list" ? { ok: true } : invalidToolType(action, "tool_list");
    },
    summarize() {
      return "List available tools";
    }
  },
  {
    name: "task_create",
    description: "Create a durable local task for multi-step agent work in the current VS Code chat session.",
    searchHint: "create planning task",
    risk: "state",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        owner: { type: "string" },
        blocks: { type: "array", items: { type: "string" } },
        blockedBy: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        reason: { type: "string" }
      },
      required: ["subject"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.subject === "string"
        ? {
          type: "task_create",
          subject: input.subject,
          description: optionalString(input.description),
          activeForm: optionalString(input.activeForm),
          owner: optionalString(input.owner),
          blocks: optionalStringArray(input.blocks),
          blockedBy: optionalStringArray(input.blockedBy),
          metadata: isRecord(input.metadata) ? input.metadata : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "task_create") {
        return invalidToolType(action, "task_create");
      }
      return validateTaskSubject(action.subject) ?? validateTaskIds(action.blocks) ?? validateTaskIds(action.blockedBy) ?? { ok: true };
    },
    summarize(action) {
      return action.type === "task_create" ? `Create task ${action.subject}` : "Create task";
    }
  },
  {
    name: "task_update",
    description: "Update a durable local task status, owner, description, dependencies, or metadata.",
    searchHint: "update planning task",
    risk: "state",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        owner: { type: "string" },
        blocks: { type: "array", items: { type: "string" } },
        blockedBy: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        reason: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.taskId === "string"
        ? {
          type: "task_update",
          taskId: input.taskId,
          subject: optionalString(input.subject),
          description: optionalString(input.description),
          activeForm: optionalString(input.activeForm),
          status: parseTaskStatus(input.status),
          owner: optionalString(input.owner),
          blocks: optionalStringArray(input.blocks),
          blockedBy: optionalStringArray(input.blockedBy),
          metadata: isRecord(input.metadata) ? input.metadata : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "task_update") {
        return invalidToolType(action, "task_update");
      }
      const idResult = validateTaskId(action.taskId);
      if (!idResult.ok) {
        return idResult;
      }
      if (action.subject !== undefined) {
        const subject = validateTaskSubject(action.subject);
        if (subject) {
          return subject;
        }
      }
      return validateTaskIds(action.blocks) ?? validateTaskIds(action.blockedBy) ?? { ok: true };
    },
    summarize(action) {
      return action.type === "task_update" ? `Update task ${action.taskId}` : "Update task";
    }
  },
  {
    name: "task_list",
    description: "List durable local tasks for the current chat session.",
    searchHint: "list planning tasks",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        owner: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return {
        type: "task_list",
        status: parseTaskStatus(input.status),
        owner: optionalString(input.owner),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      return action.type === "task_list" ? { ok: true } : invalidToolType(action, "task_list");
    },
    summarize(action) {
      return action.type === "task_list" ? `List tasks${action.status ? ` with status ${action.status}` : ""}` : "List tasks";
    }
  },
  {
    name: "task_get",
    description: "Read one durable local task for the current chat session.",
    searchHint: "read planning task",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.taskId === "string" ? { type: "task_get", taskId: input.taskId, reason: optionalString(input.reason) } : undefined;
    },
    validate(action) {
      return action.type === "task_get" ? validateTaskId(action.taskId) : invalidToolType(action, "task_get");
    },
    summarize(action) {
      return action.type === "task_get" ? `Read task ${action.taskId}` : "Read task";
    }
  },
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
  {
    name: "mcp_list_resources",
    description: "List resources from explicitly configured MCP servers.",
    searchHint: "list mcp resources",
    risk: "service",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return { type: "mcp_list_resources", serverId: optionalString(input.serverId), reason: optionalString(input.reason) };
    },
    validate(action) {
      if (action.type !== "mcp_list_resources") {
        return invalidToolType(action, "mcp_list_resources");
      }
      return action.serverId && !isSafeMcpName(action.serverId)
        ? { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." }
        : { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_list_resources" ? `List MCP resources${action.serverId ? ` on ${action.serverId}` : ""}` : "List MCP resources";
    }
  },
  {
    name: "mcp_read_resource",
    description: "Read a resource from an explicitly configured MCP server.",
    searchHint: "read mcp resource",
    risk: "service",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        uri: { type: "string" },
        reason: { type: "string" }
      },
      required: ["serverId", "uri"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.serverId === "string" && typeof input.uri === "string"
        ? { type: "mcp_read_resource", serverId: input.serverId, uri: input.uri, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "mcp_read_resource") {
        return invalidToolType(action, "mcp_read_resource");
      }
      if (!isSafeMcpName(action.serverId)) {
        return { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." };
      }
      if (!action.uri.trim() || action.uri.includes("\0") || action.uri.length > 4000) {
        return { ok: false, message: "MCP resource URI is invalid." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_read_resource" ? `Read MCP resource ${action.serverId}:${action.uri}` : "Read MCP resource";
    }
  },
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
  {
    name: "memory",
    description:
      "Save durable information to persistent curated memory that survives across sessions. Two " +
      "targets: 'user' (who the user is — preferences, communication style) and 'memory' (your own " +
      "notes — environment facts, project conventions, tool quirks). Actions: add, replace (old_text " +
      "identifies the entry), remove (old_text identifies the entry). Save proactively when the user " +
      "corrects you, shares a preference, or you learn a stable fact; keep entries compact.",
    searchHint: "save persistent curated memory user profile preferences",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        target: { type: "string", enum: ["memory", "user"] },
        content: { type: "string" },
        old_text: { type: "string" },
        reason: { type: "string" }
      },
      required: ["action", "target"],
      additionalProperties: false
    },
    parse(input) {
      const action = input.action;
      const target = input.target;
      if ((action === "add" || action === "replace" || action === "remove") && (target === "memory" || target === "user")) {
        return {
          type: "memory",
          action,
          target,
          content: optionalString(input.content),
          oldText: optionalString(input.old_text),
          reason: optionalString(input.reason)
        };
      }
      return undefined;
    },
    validate(action) {
      if (action.type !== "memory") {
        return invalidToolType(action, "memory");
      }
      if ((action.action === "add" || action.action === "replace") && !action.content?.trim()) {
        return { ok: false, message: "content is required for add/replace." };
      }
      if ((action.action === "replace" || action.action === "remove") && !action.oldText?.trim()) {
        return { ok: false, message: "old_text is required for replace/remove." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "memory" ? `${action.action} ${action.target} memory` : "Update memory";
    }
  },
  {
    name: "skill_manage",
    description:
      "Author and refine local skills (.codeforge/skills) — your procedural memory for recurring " +
      "task types. Actions: create (full SKILL.md with YAML frontmatter, name+description required), " +
      "patch (old_string/new_string — preferred for small fixes), edit (full SKILL.md rewrite), " +
      "write_file/remove_file (support files under references/, templates/, scripts/, assets/), and " +
      "delete (archives the skill — recoverable; pinned skills refuse delete). On delete pass " +
      "absorbed_into=<umbrella> when merging into another skill, or \"\" when pruning.",
    searchHint: "create edit patch delete skill procedural memory",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "edit", "delete", "write_file", "remove_file"] },
        name: { type: "string", description: "Skill name (lowercase, hyphens/underscores, <=64 chars)." },
        content: { type: "string", description: "Full SKILL.md (frontmatter + body). Required for create/edit." },
        old_string: { type: "string", description: "Text to find (patch). Unique unless replace_all." },
        new_string: { type: "string", description: "Replacement text (patch). Empty string deletes the match." },
        replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring a unique match." },
        file_path: { type: "string", description: "Support file under references/, templates/, scripts/, or assets/." },
        file_content: { type: "string", description: "Content for the support file (write_file)." },
        absorbed_into: { type: "string", description: "On delete: umbrella skill name if merged, or \"\" if pruned." },
        reason: { type: "string" }
      },
      required: ["action", "name"],
      additionalProperties: false
    },
    parse(input) {
      const action = input.action;
      if (typeof input.name !== "string" || !["create", "patch", "edit", "delete", "write_file", "remove_file"].includes(String(action))) {
        return undefined;
      }
      return {
        type: "skill_manage",
        action: action as SkillManageAction["action"],
        name: input.name,
        content: optionalString(input.content),
        oldString: optionalString(input.old_string),
        newString: typeof input.new_string === "string" ? input.new_string : undefined,
        replaceAll: input.replace_all === true ? true : undefined,
        filePath: optionalString(input.file_path),
        fileContent: typeof input.file_content === "string" ? input.file_content : undefined,
        absorbedInto: typeof input.absorbed_into === "string" ? input.absorbed_into : undefined,
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "skill_manage") {
        return invalidToolType(action, "skill_manage");
      }
      if (!action.name.trim()) {
        return { ok: false, message: "Skill name is required." };
      }
      if ((action.action === "create" || action.action === "edit") && !action.content?.trim()) {
        return { ok: false, message: "content is required for create/edit." };
      }
      if (action.action === "patch" && !action.oldString?.trim()) {
        return { ok: false, message: "old_string is required for patch." };
      }
      if ((action.action === "write_file" || action.action === "remove_file") && !action.filePath?.trim()) {
        return { ok: false, message: "file_path is required for write_file/remove_file." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "skill_manage" ? `${action.action} skill ${action.name}` : "Manage skill";
    }
  },
  {
    name: "skill_view",
    description: "Read a local skill's SKILL.md (or a support file under references/, templates/, scripts/, assets/) before patching it.",
    searchHint: "view read skill contents",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        file_path: { type: "string", description: "Optional support file path under the skill directory." },
        reason: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.name === "string"
        ? { type: "skill_view", name: input.name, filePath: optionalString(input.file_path), reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "skill_view") {
        return invalidToolType(action, "skill_view");
      }
      return action.name.trim() ? { ok: true } : { ok: false, message: "Skill name is required." };
    },
    summarize(action) {
      return action.type === "skill_view" ? `View skill ${action.name}` : "View skill";
    }
  },
  {
    name: "skills_list",
    description: "List local skills (.codeforge/skills) with their descriptions, to find an existing skill to extend before creating a new one.",
    searchHint: "list available skills",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return { type: "skills_list", reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "skills_list" ? { ok: true } : invalidToolType(action, "skills_list");
    },
    summarize() {
      return "List skills";
    }
  },
  {
    name: "fact_store",
    description: FACT_STORE_SCHEMA.description,
    searchHint: "durable fact memory save search probe reason contradict",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: FACT_STORE_SCHEMA.parameters,
    parse(input) {
      const action = input.action;
      if (!["save", "search", "probe", "related", "reason", "contradict", "delete", "list"].includes(String(action))) {
        return undefined;
      }
      return {
        type: "fact_store",
        action: action as FactStoreAction["action"],
        content: optionalString(input.content),
        category: optionalString(input.category),
        tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : undefined,
        query: optionalString(input.query),
        entity: optionalString(input.entity),
        entities: Array.isArray(input.entities) ? input.entities.filter((t): t is string => typeof t === "string") : undefined,
        id: numericOrUndefined(input.id),
        limit: typeof input.limit === "number" ? input.limit : undefined,
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "fact_store") {
        return invalidToolType(action, "fact_store");
      }
      if (action.action === "save" && !action.content?.trim()) {
        return { ok: false, message: "content is required to save a fact." };
      }
      if ((action.action === "probe" || action.action === "related") && !action.entity?.trim()) {
        return { ok: false, message: "entity is required for probe/related." };
      }
      if (action.action === "reason" && (!action.entities || action.entities.length === 0)) {
        return { ok: false, message: "entities is required for reason." };
      }
      if (action.action === "delete" && action.id === undefined) {
        return { ok: false, message: "id is required for delete." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "fact_store" ? `fact_store ${action.action}` : "fact store";
    }
  },
  {
    name: "fact_feedback",
    description: FACT_FEEDBACK_SCHEMA.description,
    searchHint: "rate durable fact trust feedback helpful",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: FACT_FEEDBACK_SCHEMA.parameters,
    parse(input) {
      const id = numericOrUndefined(input.id);
      if (id === undefined || typeof input.helpful !== "boolean") {
        return undefined;
      }
      return { type: "fact_feedback", id, helpful: input.helpful, reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "fact_feedback" ? { ok: true } : invalidToolType(action, "fact_feedback");
    },
    summarize(action) {
      return action.type === "fact_feedback" ? `fact_feedback ${action.helpful ? "helpful" : "unhelpful"}` : "fact feedback";
    }
  },
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
  {
    name: "mcp_call_tool",
    description: "Call a tool on an explicitly configured MCP server after permission approval.",
    searchHint: "call mcp tool",
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

export function isConcurrencySafeAction(action: AgentAction): boolean {
  return Boolean(findTool(action.type)?.concurrencySafe);
}

export function isApprovalAction(action: AgentAction): action is AskUserQuestionAction | ProposePatchAction | WriteFileAction | EditFileAction | NotebookEditCellAction | RunCommandAction | McpCallToolAction {
  const tool = findTool(action.type);
  return Boolean(tool?.requiresApproval);
}

export function toolSummary(action: AgentAction): string {
  return findTool(action.type)?.summarize(action) ?? action.type;
}
