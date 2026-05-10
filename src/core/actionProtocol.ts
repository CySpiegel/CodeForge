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
    { "type": "write_file", "path": "relative/path.ts", "content": "full file text", "reason": "why" },
    { "type": "edit_file", "path": "relative/path.ts", "oldText": "exact text", "newText": "replacement text", "reason": "why" },
    { "type": "open_diff", "patch": "unified diff", "reason": "why" },
    { "type": "propose_patch", "patch": "unified diff", "reason": "why" },
    { "type": "run_command", "command": "npm test", "cwd": ".", "reason": "why" },
    { "type": "mcp_call_tool", "serverId": "configured-server", "toolName": "tool/name", "arguments": {}, "reason": "why" }
  ]
}

Prefer VS Code-native list/glob/grep/read/diagnostics/edit/write tools over shell commands for workspace file work. Only call MCP tools when the user asks for a configured local/on-prem service integration or when workspace context clearly requires it; never invent MCP server IDs. When the user refers to "this file", "the current file", or "the file I have open", use the activeFile context item label as the target path. If the activeFile label says it is unsaved, explain that it must be saved inside the workspace before write_file or edit_file can apply. For an empty active workspace file, prefer write_file with the full file content. Do not claim that edits, MCP calls, or commands were applied; CodeForge will ask the user to approve them when policy requires it.`;

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
