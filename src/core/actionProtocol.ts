import { parseAction, toolDefinitions } from "./toolRegistry";
import { AgentAction } from "./types";

interface ActionEnvelope {
  readonly actions?: readonly unknown[];
}

export const actionProtocolInstructions = `You are CodeForge, a self-hosted-first coding harness inside VS Code.

Prefer concise answers. When you need workspace data, request one or more actions using this exact JSON shape:

{
  "actions": [
    { "type": "list_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "glob_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "why" },
    { "type": "read_file", "path": "relative/path.ts", "reason": "why" },
    { "type": "search_text", "query": "symbol or text", "reason": "why" },
    { "type": "grep_text", "query": "symbol or text", "include": "src/**/*.ts", "limit": 50, "reason": "why" },
    { "type": "list_diagnostics", "path": "relative/path.ts", "limit": 50, "reason": "why" },
    { "type": "spawn_agent", "agent": "review", "prompt": "review the auth changes", "description": "review auth", "background": false, "reason": "why" },
    { "type": "worker_output", "workerId": "worker-id", "reason": "why" },
    { "type": "ask_user_question", "questions": [{ "question": "Which approach should CodeForge use?", "header": "Approach", "options": [{ "label": "Small patch", "description": "Make the smallest focused change." }, { "label": "Refactor", "description": "Restructure the affected module first." }] }], "reason": "why" },
    { "type": "tool_list", "reason": "why" },
    { "type": "task_create", "subject": "Implement auth middleware", "description": "Add JWT validation", "reason": "why" },
    { "type": "task_update", "taskId": "task-1234567890-abc", "status": "in_progress", "reason": "why" },
    { "type": "task_list", "status": "pending", "reason": "why" },
    { "type": "task_get", "taskId": "task-1234567890-abc", "reason": "why" },
    { "type": "code_hover", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_definition", "path": "relative/path.ts", "line": 10, "character": 5, "reason": "why" },
    { "type": "code_references", "path": "relative/path.ts", "line": 10, "character": 5, "includeDeclaration": false, "reason": "why" },
    { "type": "code_symbols", "path": "relative/path.ts", "reason": "why" },
    { "type": "mcp_list_resources", "serverId": "configured-server", "reason": "why" },
    { "type": "mcp_read_resource", "serverId": "configured-server", "uri": "resource-uri", "reason": "why" },
    { "type": "notebook_read", "path": "notebooks/example.ipynb", "reason": "why" },
    { "type": "notebook_edit_cell", "path": "notebooks/example.ipynb", "index": 0, "content": "print('hello')", "language": "python", "kind": "code", "reason": "why" },
    { "type": "memory_write", "text": "stable preference or repo fact to remember", "scope": "workspace", "agent": "optional-agent-name", "reason": "why" },
    { "type": "write_file", "path": "relative/path.ts", "content": "full file text", "reason": "why" },
    { "type": "edit_file", "path": "relative/path.ts", "oldText": "exact text", "newText": "replacement text", "reason": "why" },
    { "type": "open_diff", "patch": "unified diff", "reason": "why" },
    { "type": "propose_patch", "patch": "unified diff", "reason": "why" },
    { "type": "run_command", "command": "npm test", "cwd": ".", "reason": "why" },
    { "type": "mcp_call_tool", "serverId": "configured-server", "toolName": "tool/name", "arguments": {}, "reason": "why" }
  ]
}

Prefer VS Code-native list/glob/grep/read/diagnostics/edit/write tools over shell commands for workspace file work. Use code_hover, code_definition, code_references, and code_symbols when language-server evidence is better than text search. Use notebook_read and notebook_edit_cell for VS Code notebook files. Use task_create/task_update/task_list/task_get to track multi-step work internally during larger agent workflows. Use ask_user_question when blocked by a real product or implementation choice; CodeForge will pause and collect the user's answer. Use spawn_agent to delegate focused codebase exploration, review, verification, or implementation to built-in or workspace-local agents when parallel or specialist work helps. Use worker_output to retrieve an agent/worker transcript. Use tool_list if you need to inspect the available tool surface. Use memory_write only for stable user preferences or repository facts worth preserving across sessions; it requires approval. Only call MCP tools/resources when the user asks for a configured local/on-prem service integration or when workspace context clearly requires it; never invent MCP server IDs. When the user refers to "this file", "the current file", or "the file I have open", use the activeFile context item label as the target path. If the activeFile label says it is unsaved, explain that it must be saved inside the workspace before write_file, edit_file, or notebook_edit_cell can apply. For an empty active workspace file, prefer write_file with the full file content. Do not claim that edits, memory writes, MCP calls, commands, or user answers were applied; CodeForge will route them through the local tool path.`;

export { toolDefinitions };

export function parseActionsFromAssistantText(text: string): readonly AgentAction[] {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ActionEnvelope;
      const actions = parseActionArray(parsed.actions);
      if (actions.length > 0) {
        return actions;
      }
    } catch {
      continue;
    }
  }

  return [];
}

export function parseToolAction(name: string, argumentsJson: string): AgentAction | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    return normalizeAction({ ...parsed, type: name });
  } catch {
    return undefined;
  }
}

function extractJsonCandidates(text: string): readonly string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  return candidates;
}

function parseActionArray(actions: readonly unknown[] | undefined): readonly AgentAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.map(normalizeAction).filter((action): action is AgentAction => Boolean(action));
}

function normalizeAction(value: unknown): AgentAction | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  return parseAction(value.type, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
