import { isRecord } from "./guards";
import { parseToolArguments } from "./openaiToolArgs";
import { parseAction, toolDefinitions } from "./toolRegistry";
import { AgentAction } from "./types";

interface ActionEnvelope {
  readonly actions?: readonly unknown[];
}

export type ToolActionParseResult =
  | { readonly ok: true; readonly action: AgentAction }
  | { readonly ok: false; readonly message: string };

export const actionProtocolInstructions = `You are CodeForge, a self-hosted-first coding harness inside VS Code.

Prefer concise answers. When native tool calls are unavailable, request one or more actions using this JSON shape:

{
  "actions": [
    { "type": "list_files", "pattern": "src/**/*.ts", "limit": 100, "reason": "find candidate files" },
    { "type": "read_file", "path": "relative/path.ts", "reason": "why" },
    { "type": "grep_text", "query": "symbol or text", "include": "src/**/*.ts", "limit": 50, "reason": "why" },
    { "type": "tool_search", "query": "code symbols", "limit": 5, "reason": "load the right schema" }
  ]
}

CodeForge uses deferred tool schemas for local-model reliability. The current mode controls which tools are available. Ask and Plan modes are read-only; Agent mode can also expose side-effect tools such as file edits and approved terminal commands. The always-loaded core tool surface includes workspace list/glob/grep/read/diagnostics, tool_list, and tool_search. Specialized tools are deferred until loaded: task_* state tools, code_* language-service tools, notebook tools, the memory tool, MCP resource/tools, concrete MCP server tools, and write/command tools when the mode allows them.

If you need a deferred capability, call tool_search first with a capability query or select:tool_name. CodeForge will return matching schemas and load those tools on the next model turn. Use tool_list for a compact catalog overview, and tool_search for exact schemas.

Workspace read tools execute locally through VS Code against the open repo folder. Use list_files, glob_files, grep_text, search_text, read_file, and list_diagnostics for codebase-specific questions when the needed evidence is not already attached. Do not invent paths. Before calling read_file for a path that was not provided by the user or earlier tool output, discover the exact repo-relative path with list_files, glob_files, grep_text, or search_text. If a search result returns path:line or path:line:column, call read_file with only the path. If read_file reports a missing file, do not retry the same guessed path; discover candidate paths first. Read-only tools are auto-approved by CodeForge; side effects such as edits, commands, memory writes, and service calls are routed through the permission system.

Prefer VS Code-native list/glob/grep/read/diagnostics/edit/write tools over shell commands for repo file work. Before edit_file, read the target file in the current session and copy oldText exactly from the current file contents. If edit_file or propose_patch fails, inspect the current file contents and retry with exact context instead of repeating the same failed edit. Use code_hover, code_definition, code_references, and code_symbols after loading them when language-server evidence is better than text search. Use notebook_read and notebook_edit_cell after loading them for VS Code notebook files. Use task_create/task_update/task_list/task_get after loading them to track multi-step work internally during larger agent workflows. Use ask_user_question when blocked by a real product or implementation choice; CodeForge will pause and collect the user's answer. Use spawn_agent to delegate focused codebase exploration, review, verification, or implementation to built-in or workspace-local agents when parallel or specialist work helps. Use worker_output to retrieve an agent/worker transcript. Use the memory tool (action add/replace/remove, target memory|user) to save durable user preferences or repository facts worth preserving across sessions; save proactively when the user corrects you or shares a preference, and keep entries compact. Use skills_list and skill_view to discover and read local skills (.codeforge/skills), and skill_manage (create/patch/edit/write_file/remove_file/delete) to author and refine a reusable skill when a non-trivial procedure recurs; skill_view before patching to copy exact text. When the durable memory backend is enabled, fact_store (save/search/probe/related/reason/contradict) keeps a searchable long-term fact store and fact_feedback adjusts a fact's trust; relevant facts are recalled into context automatically. Only call MCP tools/resources when the user asks for a configured service integration or when repo context clearly requires it; never invent MCP server IDs. When the user refers to "this file", "the current file", or "the file I have open", ask them to pin or name the file unless a repo-relative path is already attached in the chat. Do not claim that edits, memory writes, MCP calls, commands, or user answers were applied; CodeForge will route them through the local tool path.`;

export { toolDefinitions };

export function parseActionsFromAssistantText(text: string): readonly AgentAction[] {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    // Tolerate truncated/malformed action JSON the same way native tool calls are tolerated. A local
    // model without native tool-calling emits the {"actions":[...]} protocol as text; cut off
    // mid-string it would otherwise parse to zero actions and the turn would silently end without
    // running the requested tool. parseToolArguments repairs the truncated object before we read it.
    const parsed = parseToolArguments(candidate);
    if (!parsed.ok) {
      continue;
    }
    const actions = parseActionArray((parsed.value as ActionEnvelope).actions);
    if (actions.length > 0) {
      return actions;
    }
  }

  return [];
}

export function parseToolAction(name: string, argumentsJson: string): AgentAction | undefined {
  const result = parseToolActionDetailed(name, argumentsJson);
  return result.ok ? result.action : undefined;
}

export function parseToolActionDetailed(name: string, argumentsJson: string): ToolActionParseResult {
  const toolName = name.trim();
  if (!toolName) {
    return { ok: false, message: "Tool call did not include a function name." };
  }

  // Tool-call `arguments` is a model-generated string that the OpenAI spec does not guarantee to be
  // valid JSON; local/streamed backends frequently truncate it mid-string. Recover what we can before
  // failing, and when it is unrecoverable return a clear, retryable instruction instead of a raw
  // JSON.parse error so the model re-issues the call.
  const args = parseToolArguments(argumentsJson);
  if (!args.ok) {
    return {
      ok: false,
      message: `Arguments for ${toolName} could not be parsed as a JSON object — they were missing, malformed, or truncated (e.g. a tool call cut off mid-string). Re-issue the ${toolName} call with complete, valid JSON arguments.`
    };
  }

  const action = normalizeAction({ ...args.value, type: toolName });
  if (!action) {
    return { ok: false, message: `Tool ${toolName} is unknown or missing required parameters.` };
  }

  return { ok: true, action };
}

function extractJsonCandidates(text: string): readonly string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }

  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    const lastBrace = text.lastIndexOf("}");
    // A complete object slice when there is a closing brace; otherwise the open-ended remainder — the
    // model truncated mid-value and the closing brace is gone — which the repair step in
    // parseActionsFromAssistantText completes. Without this, a truncated envelope yields no candidate
    // at all and the action is silently dropped.
    candidates.push(lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : text.slice(firstBrace));
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
