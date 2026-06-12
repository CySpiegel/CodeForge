import { parseToolActionDetailed, ToolActionParseResult, toolDefinitions } from "./actionProtocol";
import { isRecord } from "./guards";
import { McpToolSummary } from "./mcpClient";
import { codeForgeTools } from "./toolRegistry";
import { AgentMode, ChatMessage, ToolCall } from "./types";

// Markers the model echoes back in the transcript once a tool/MCP schema has been loaded via
// tool_search, so later turns can tell which schemas are already in context.
export const codeForgeToolSchemaMarker = "CODEFORGE_TOOL_SCHEMA_LOADED:";
export const mcpToolSchemaMarker = "CODEFORGE_MCP_TOOL_SCHEMA_LOADED:";

// Tools whose schemas are loaded up front (vs deferred until tool_search). Agent mode vs read-only modes.
export const coreAgentToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "tool_list",
  "ask_user_question",
  "spawn_agent",
  "worker_output",
  "open_diff",
  "propose_patch",
  "write_file",
  "edit_file",
  "run_command"
]);

export const coreReadOnlyToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "tool_list",
  "ask_user_question",
  "worker_output"
]);

// Tools available in read-only agent modes (ask/plan). Agent mode exposes the full set.
export const readOnlyToolNames = new Set([
  "list_files",
  "glob_files",
  "read_file",
  "search_text",
  "grep_text",
  "list_diagnostics",
  "tool_search",
  "ask_user_question",
  "tool_list",
  "task_list",
  "task_get",
  "code_hover",
  "code_definition",
  "code_references",
  "code_symbols",
  "mcp_list_resources",
  "mcp_read_resource",
  "notebook_read"
]);

export interface McpToolBinding {
  readonly serverId: string;
  readonly toolName: string;
}

export interface ToolSchemaSearchResult {
  readonly name: string;
  readonly score: number;
  readonly content: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeToolNameSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

// Built-in tools the model may call in this agent mode. Read-only modes (ask/plan) drop write/exec tools.
export function toolDefinitionsForAgentMode(mode: AgentMode): typeof toolDefinitions {
  if (mode === "agent") {
    return toolDefinitions;
  }
  return toolDefinitions.filter((tool) => readOnlyToolNames.has(tool.name));
}

// Derive a stable, collision-free `mcp__<server>__<tool>` function name within the 64-char API limit.
export function mcpFunctionName(serverId: string, toolName: string, usedNames: ReadonlySet<string>): string {
  const server = safeToolNameSegment(serverId).slice(0, 18) || "server";
  const tool = safeToolNameSegment(toolName).slice(0, 36) || "tool";
  const base = `mcp__${server}__${tool}`.slice(0, 64);
  if (!usedNames.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index++) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, 55)}_${Date.now().toString(36).slice(-8)}`;
}

export function mcpToolParameters(inputSchema: unknown): Record<string, unknown> {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema;
  }
  return {
    type: "object",
    additionalProperties: true
  };
}

export function discoveredCodeForgeToolNames(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(new RegExp(`${escapeRegExp(codeForgeToolSchemaMarker)}\\s*([a-zA-Z0-9_]+)`, "g"))) {
      names.add(match[1]);
    }
  }
  return names;
}

export function discoveredMcpToolNames(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(new RegExp(`${escapeRegExp(mcpToolSchemaMarker)}\\s*([a-zA-Z0-9_]+)`, "g"))) {
      names.add(match[1]);
    }
  }
  return names;
}

export function searchCodeForgeTools(query: string, allowedToolNames: ReadonlySet<string>): readonly ToolSchemaSearchResult[] {
  const selected = selectedToolNames(query);
  return codeForgeTools
    .filter((tool) => allowedToolNames.has(tool.name))
    .map((tool): ToolSchemaSearchResult => ({
      name: tool.name,
      score: scoreToolSearch(query, selected, tool.name, tool.description, [tool.searchHint ?? "", tool.risk, tool.requiresApproval ? "approval" : "auto"]),
      content: formatCodeForgeToolSchemaSearchResult(tool)
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function selectedToolNames(query: string): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const match of query.matchAll(/select:([a-zA-Z0-9_,\-\s]+)/g)) {
    for (const name of match[1].split(/[,\s]+/)) {
      const normalized = name.trim();
      if (normalized) {
        selected.add(normalized);
      }
    }
  }
  return selected;
}

export function scoreToolSearch(query: string, selected: ReadonlySet<string>, name: string, description: string | undefined, tags: readonly string[]): number {
  if (selected.size > 0) {
    return selected.has(name) ? 1000 : 0;
  }

  const normalizedQuery = query.toLowerCase().replace(/select:[^\s]+/g, " ");
  const terms = normalizedQuery.split(/[^a-z0-9_/-]+/).map((term) => term.trim()).filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return 0;
  }

  const haystack = [name, description ?? "", ...tags].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.toLowerCase() === term) {
      score += 80;
    } else if (name.toLowerCase().includes(term)) {
      score += 45;
    } else if (haystack.includes(term)) {
      score += 15;
    }
  }
  return score;
}

export function formatCodeForgeToolSchemaSearchResult(tool: (typeof codeForgeTools)[number]): string {
  return [
    `${codeForgeToolSchemaMarker} ${tool.name}`,
    `Name: ${tool.name}`,
    `Risk: ${tool.risk}`,
    `Approval: ${tool.requiresApproval ? "required when policy asks" : "not required"}`,
    `Concurrency: ${tool.concurrencySafe ? "safe" : "serial"}`,
    tool.searchHint ? `Search hint: ${tool.searchHint}` : undefined,
    `Description: ${tool.description}`,
    "Schema:",
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }, null, 2)
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatMcpToolSchemaSearchResult(functionName: string, serverId: string, tool: McpToolSummary): string {
  return [
    `${mcpToolSchemaMarker} ${functionName}`,
    `Name: ${functionName}`,
    `Server: ${serverId}`,
    `MCP tool: ${tool.name}`,
    tool.description ? `Description: ${tool.description}` : undefined,
    "Schema:",
    JSON.stringify({
      name: functionName,
      description: `Call MCP tool ${tool.name} on configured server ${serverId}. ${tool.description ?? ""}`.trim(),
      parameters: mcpToolParameters(tool.inputSchema)
    }, null, 2)
  ].filter((line): line is string => line !== undefined).join("\n");
}

// Parse a native tool call into an action, falling back to an mcp_call_tool action when the tool name
// matches a discovered MCP binding rather than a built-in tool.
export function parseNativeToolCall(toolCall: ToolCall, mcpToolBindings: ReadonlyMap<string, McpToolBinding>): ToolActionParseResult {
  const parsed = parseToolActionDetailed(toolCall.name, toolCall.argumentsJson);
  if (parsed.ok) {
    return parsed;
  }

  const binding = mcpToolBindings.get(toolCall.name);
  if (!binding) {
    return parsed;
  }

  let args: unknown;
  try {
    args = JSON.parse(toolCall.argumentsJson || "{}");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Arguments for ${toolCall.name} must be valid JSON. ${detail}` };
  }
  if (!isRecord(args)) {
    return { ok: false, message: `Arguments for ${toolCall.name} must be a JSON object.` };
  }

  return {
    ok: true,
    action: {
      type: "mcp_call_tool",
      serverId: binding.serverId,
      toolName: binding.toolName,
      arguments: args,
      reason: `Call MCP tool ${binding.toolName} on ${binding.serverId}`
    }
  };
}
