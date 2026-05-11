import { parseUnifiedDiff } from "./unifiedDiff";
import { classifyShellCommand } from "./shellSemantics";
import {
  AgentAction,
  AskUserQuestionAction,
  CodeDefinitionAction,
  CodeForgeTaskStatus,
  CodeHoverAction,
  CodeReferencesAction,
  EditFileAction,
  GlobFilesAction,
  GrepTextAction,
  ListDiagnosticsAction,
  ListFilesAction,
  MemoryWriteAction,
  McpCallToolAction,
  NotebookEditCellAction,
  ProposePatchAction,
  ReadFileAction,
  RunCommandAction,
  SearchTextAction,
  ToolDefinition,
  NotebookCellKindName,
  QuestionOption,
  UserQuestion,
  WriteFileAction
} from "./types";

export type ToolRisk = "read" | "search" | "automation" | "question" | "memory" | "state" | "service" | "edit" | "command";

export interface ToolValidationResult {
  readonly ok: boolean;
  readonly message?: string;
}

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
    description: "List files in the current VS Code workspace. Use this before repo-wide reviews, architecture questions, or unfamiliar-code tasks to discover relevant workspace-relative paths.",
    searchHint: "discover workspace files",
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
    description: "Fast file pattern matching in the current VS Code workspace. Use this when you need files by name or extension, such as **/*.ts or src/**/*.tsx.",
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
    description: "Read exact text contents from one workspace file. Use this before explaining, reviewing, editing, or reasoning about a specific file path returned by list_files, glob_files, grep_text, or active file context.",
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
    description: "Search plain text across the current workspace. Prefer grep_text when you need an include glob, a bounded result count, or code-review evidence from matching files.",
    searchHint: "search workspace text",
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
    description: "Search workspace file contents with a query and optional include glob. Use this for codebase reviews, symbol hunting, API usage checks, TODO/error searches, and narrowing files before read_file.",
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
    description: "List current VS Code diagnostics for the workspace or one workspace file. Use this to inspect TypeScript, lint, language-server, and problem-panel evidence before suggesting fixes.",
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
    description: "Read the current status and transcript of a CodeForge worker or local agent.",
    searchHint: "read worker transcript",
    risk: "automation",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["workerId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.workerId === "string"
        ? { type: "worker_output", workerId: input.workerId, reason: optionalString(input.reason) }
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
    description: "List resources from explicitly configured local/on-prem MCP servers.",
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
    description: "Read a resource from an explicitly configured local/on-prem MCP server.",
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
    name: "memory_write",
    description: "Persist a durable local memory after user approval. Use for stable user preferences or repository facts that should affect future sessions.",
    searchHint: "save persistent memory",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        scope: { type: "string", enum: ["workspace", "user", "agent"] },
        agent: { type: "string" },
        reason: { type: "string" }
      },
      required: ["text"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.text === "string"
        ? {
          type: "memory_write",
          text: input.text,
          scope: input.scope === "workspace" || input.scope === "user" || input.scope === "agent" ? input.scope : undefined,
          agent: optionalString(input.agent),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "memory_write") {
        return invalidToolType(action, "memory_write");
      }
      if (!action.text.trim()) {
        return { ok: false, message: "Memory text must not be empty." };
      }
      if (Buffer.byteLength(action.text, "utf8") > 12000) {
        return { ok: false, message: "Memory text is too large." };
      }
      if (action.scope === "agent" && (!action.agent || !isSafeExtensionName(action.agent))) {
        return { ok: false, message: "Agent memory requires a safe agent name." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "memory_write" ? `Save ${action.scope ?? "workspace"} memory` : "Save memory";
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
    name: "mcp_call_tool",
    description: "Call a tool on an explicitly configured local/on-prem MCP server after permission approval.",
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

export function isLocalReadOnlyAction(action: AgentAction): action is ListFilesAction | GlobFilesAction | ReadFileAction | SearchTextAction | GrepTextAction | ListDiagnosticsAction {
  return action.type === "list_files"
    || action.type === "glob_files"
    || action.type === "read_file"
    || action.type === "search_text"
    || action.type === "grep_text"
    || action.type === "list_diagnostics";
}

export function isReadOnlyAction(action: AgentAction): boolean {
  return isLocalReadOnlyAction(action)
    || action.type === "ask_user_question"
    || action.type === "tool_search"
    || action.type === "tool_list"
    || action.type === "task_list"
    || action.type === "task_get"
    || action.type === "code_hover"
    || action.type === "code_definition"
    || action.type === "code_references"
    || action.type === "code_symbols"
    || action.type === "mcp_list_resources"
    || action.type === "mcp_read_resource"
    || action.type === "notebook_read"
    || action.type === "open_diff"
    || action.type === "spawn_agent"
    || action.type === "worker_output";
}

export function isConcurrencySafeAction(action: AgentAction): boolean {
  return Boolean(findTool(action.type)?.concurrencySafe);
}

export function isApprovalAction(action: AgentAction): action is AskUserQuestionAction | ProposePatchAction | WriteFileAction | EditFileAction | NotebookEditCellAction | MemoryWriteAction | RunCommandAction | McpCallToolAction {
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

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeMcpName(value: string): boolean {
  return /^[A-Za-z0-9._/-]{1,160}$/.test(value) && !value.includes("..");
}

function isSafeExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
}

function isSafeWorkerId(value: string): boolean {
  return /^worker-\d+-[a-f0-9]+$/i.test(value);
}

function parseQuestions(value: unknown): readonly UserQuestion[] {
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

function parseTaskStatus(value: unknown): CodeForgeTaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "blocked" || value === "completed" || value === "cancelled"
    ? value
    : undefined;
}

function parseNotebookCellKind(value: unknown): NotebookCellKindName | undefined {
  return value === "code" || value === "markdown" ? value : undefined;
}

function validateTaskSubject(subject: string): ToolValidationResult | undefined {
  const trimmed = subject.trim();
  if (!trimmed) {
    return { ok: false, message: "Task subject must not be empty." };
  }
  if (trimmed.length > 240) {
    return { ok: false, message: "Task subject must be 240 characters or fewer." };
  }
  return undefined;
}

function validateTaskId(taskId: string): ToolValidationResult {
  return /^task-\d+-[a-f0-9]+$/i.test(taskId)
    ? { ok: true }
    : { ok: false, message: "Task id is invalid." };
}

function validateTaskIds(taskIds: readonly string[] | undefined): ToolValidationResult | undefined {
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

function codePositionParameters(): Record<string, unknown> {
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

function parseCodePosition(type: CodeHoverAction["type"], input: Record<string, unknown>): CodeHoverAction | undefined;
function parseCodePosition(type: CodeDefinitionAction["type"], input: Record<string, unknown>): CodeDefinitionAction | undefined;
function parseCodePosition(type: CodeReferencesAction["type"], input: Record<string, unknown>): CodeReferencesAction | undefined;
function parseCodePosition(type: CodeHoverAction["type"] | CodeDefinitionAction["type"] | CodeReferencesAction["type"], input: Record<string, unknown>): CodeHoverAction | CodeDefinitionAction | CodeReferencesAction | undefined {
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

function validateCodePosition(action: CodeHoverAction | CodeDefinitionAction | CodeReferencesAction): ToolValidationResult {
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
