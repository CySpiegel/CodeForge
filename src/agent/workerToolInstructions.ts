import { WorkerDefinition } from "../core/workerTypes";

// Declarative catalog of the per-capability tool-usage instruction blocks injected into a worker's
// system prompt. workerToolInstruction() assembles the relevant blocks from a worker definition's
// allowed tools — purely parameter-driven, no shared state, so it lives apart from the worker run engine.

const workerReadToolInstruction = `When you need repo data, request one or more actions using this JSON shape and only these action types:

{
  "actions": [
    { "type": "list_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "glob_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "read_file", "path": "relative/path.ts", "reason": "why" },
    { "type": "search_text", "query": "symbol or text", "reason": "why" },
    { "type": "grep_text", "query": "symbol or text", "include": "src/**/*.ts", "limit": 50, "reason": "why" },
    { "type": "list_diagnostics", "path": "relative/path.ts", "limit": 50, "reason": "why" }
  ]
}

Use repo-relative paths only. If a tool is denied, adjust within the allowed read-only scope.`;

const workerCodeIntelToolInstruction = `This worker may also use VS Code language-service tools when symbol-aware code intelligence is more reliable than text search:

{
  "actions": [
    { "type": "code_hover", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_definition", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_references", "path": "relative/path.ts", "line": 10, "character": 5, "includeDeclaration": false, "reason": "why" },
    { "type": "code_symbols", "path": "relative/path.ts", "reason": "why" }
  ]
}`;

const workerStateToolInstruction = `This worker may also use local task-state tools to track multi-step work internally:

{
  "actions": [
    { "type": "tool_search", "query": "task tracking", "reason": "load task tool schemas" },
    { "type": "tool_list", "reason": "inspect available tools" },
    { "type": "task_create", "subject": "short task", "description": "details", "reason": "why" },
    { "type": "task_update", "taskId": "task-1234567890-abc", "status": "in_progress", "reason": "why" },
    { "type": "task_list", "reason": "check current tasks" },
    { "type": "task_get", "taskId": "task-1234567890-abc", "reason": "why" }
  ]
}

Tasks are local session state for coordination and progress tracking. They do not edit repo files.`;

const workerQuestionToolInstruction = `This worker may also pause and ask the user a structured question when blocked by missing requirements:

{
  "actions": [
    { "type": "ask_user_question", "questions": [{ "question": "Which implementation path should I use?", "header": "Approach", "options": [{ "label": "Small patch", "description": "Make the narrowest change." }, { "label": "Refactor", "description": "Restructure before editing." }] }], "reason": "why the answer is needed" }
  ]
}

Ask only when the answer changes the implementation.`;

const workerNotebookToolInstruction = `This worker may also use VS Code notebook tools:

{
  "actions": [
    { "type": "notebook_read", "path": "notebooks/example.ipynb", "reason": "why" },
    { "type": "notebook_edit_cell", "path": "notebooks/example.ipynb", "index": 0, "content": "print('hello')", "language": "python", "kind": "code", "reason": "why" }
  ]
}

Notebook edits are routed through the parent VS Code approval, checkpoint, and permission policy.`;

const workerEditToolInstruction = `This worker may also request approval-gated edit actions when edits are needed:

{
  "actions": [
    { "type": "edit_file", "path": "relative/path.ts", "oldText": "exact text", "newText": "replacement text", "reason": "why" },
    { "type": "write_file", "path": "relative/path.ts", "content": "full file text", "reason": "why" },
    { "type": "propose_patch", "patch": "unified diff", "reason": "why" },
    { "type": "open_diff", "patch": "unified diff", "reason": "why" }
  ]
}

Read before editing. Use repo-relative paths only. Edits are not hidden background changes; CodeForge routes them through the parent VS Code approval, diff preview, checkpoint, and permission policy.`;

const workerCommandToolInstruction = `This worker may also request approval-gated local command execution when verification or diagnostics require it:

{
  "actions": [
    { "type": "run_command", "command": "npm test", "cwd": ".", "reason": "why this command is needed" }
  ]
}

Prefer VS Code-native read/search/diagnostic tools first. Keep commands repo-scoped, foreground, and bounded. Commands are routed through the parent VS Code approval, checkpoint, timeout, output limit, and permission policy.`;

const workerAutomationToolInstruction = `This worker may also delegate focused work to another CodeForge agent:

{
  "actions": [
    { "type": "spawn_agent", "agent": "review", "prompt": "focused task", "description": "short label", "background": false, "reason": "why" },
    { "type": "worker_output", "workerId": "worker-id", "reason": "why" }
  ]
}

Use delegation for independent review, exploration, or verification work. The spawned agent inherits CodeForge's local endpoint, repo context, permission policy, and approval bridge.`;

const workerMcpResourceToolInstruction = `This worker may also read resources from explicitly configured MCP servers:

{
  "actions": [
    { "type": "mcp_list_resources", "serverId": "configured-server", "reason": "why" },
    { "type": "mcp_read_resource", "serverId": "configured-server", "uri": "resource-uri", "reason": "why" }
  ]
}

Never invent MCP server IDs.`;

export function workerToolInstruction(definition: WorkerDefinition): string {
  const canEdit = definition.allowedToolNames.some((tool) => tool === "edit_file" || tool === "write_file" || tool === "propose_patch" || tool === "open_diff");
  const canCommand = definition.allowedToolNames.some((tool) => tool === "run_command");
  const canAutomate = definition.allowedToolNames.some((tool) => tool === "spawn_agent" || tool === "worker_output");
  const canCodeIntel = definition.allowedToolNames.some((tool) => tool === "code_hover" || tool === "code_definition" || tool === "code_references" || tool === "code_symbols");
  const canState = definition.allowedToolNames.some((tool) => tool === "tool_search" || tool === "tool_list" || tool === "task_create" || tool === "task_update" || tool === "task_list" || tool === "task_get");
  const canQuestion = definition.allowedToolNames.some((tool) => tool === "ask_user_question");
  const canMcpResource = definition.allowedToolNames.some((tool) => tool === "mcp_list_resources" || tool === "mcp_read_resource");
  const canNotebook = definition.allowedToolNames.some((tool) => tool === "notebook_read" || tool === "notebook_edit_cell");
  return [
    workerReadToolInstruction,
    canCodeIntel ? workerCodeIntelToolInstruction : undefined,
    canState ? workerStateToolInstruction : undefined,
    canQuestion ? workerQuestionToolInstruction : undefined,
    canNotebook ? workerNotebookToolInstruction : undefined,
    canEdit ? workerEditToolInstruction : undefined,
    canCommand ? workerCommandToolInstruction : undefined,
    canAutomate ? workerAutomationToolInstruction : undefined,
    canMcpResource ? workerMcpResourceToolInstruction : undefined
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}
