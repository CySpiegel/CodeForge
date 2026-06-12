import { inspectConfiguredMcpServers } from "../core/mcpClient";
import { toolDefinitions } from "../core/actionProtocol";
import { codeForgeTools } from "../core/toolRegistry";
import {
  coreAgentToolNames,
  coreReadOnlyToolNames,
  formatMcpToolSchemaSearchResult,
  mcpFunctionName,
  scoreToolSearch,
  searchCodeForgeTools,
  selectedToolNames,
  toolDefinitionsForAgentMode,
  ToolSchemaSearchResult
} from "../core/toolDiscovery";
import { AgentAction, AgentMode, McpServerConfig, NetworkPolicy } from "../core/types";

export interface ToolSchemaDeps {
  getAgentMode(): AgentMode;
  getMcpServers(): readonly McpServerConfig[];
  getNetworkPolicy(): NetworkPolicy;
  signal(): AbortSignal | undefined;
}

// Implements the tool_list and tool_search tools: list the CodeForge tool catalog (core vs deferred) and
// search CodeForge + configured MCP tool schemas, returning the transcript strings the dispatcher feeds
// back to the model. Read-only — no controller run-state.
export class ToolSchemaService {
  constructor(private readonly deps: ToolSchemaDeps) {}

  formatList(): string {
    const coreNames = this.deps.getAgentMode() === "agent" ? coreAgentToolNames : coreReadOnlyToolNames;
    const lines = codeForgeTools.map((tool) => {
      const loading = coreNames.has(tool.name) ? "core" : "deferred";
      const approval = tool.requiresApproval ? "approval" : "auto";
      const concurrent = tool.concurrencySafe ? "concurrent" : "serial";
      return `- ${tool.name} | ${loading} | risk=${tool.risk} | ${approval} | ${concurrent} | ${tool.description}`;
    });
    return `tool_list\n\n${lines.join("\n")}\n\nUse tool_search with a capability query or select:tool_name to load deferred schemas.`;
  }

  async search(action: Extract<AgentAction, { readonly type: "tool_search" }>): Promise<string> {
    const mode = this.deps.getAgentMode();
    const allowedToolNames = new Set(toolDefinitionsForAgentMode(mode).map((tool) => tool.name));
    const limit = Math.max(1, Math.min(action.limit ?? 8, 20));
    const codeForgeMatches = searchCodeForgeTools(action.query, allowedToolNames);
    const mcpMatches = mode === "agent"
      ? await this.searchMcp(action.query, limit)
      : [];
    const combined = [...codeForgeMatches, ...mcpMatches]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);

    if (combined.length === 0) {
      return [
        `tool_search ${action.query}`,
        "",
        "No matching tools found.",
        "Try broader terms such as code symbols, task tracking, notebook, memory, mcp, command, edit, or select:tool_name."
      ].join("\n");
    }

    return [
      `tool_search ${action.query}`,
      "",
      "The following schemas are now loaded for the next model turn:",
      "",
      ...combined.map((match) => match.content)
    ].join("\n");
  }

  private async searchMcp(query: string, limit: number): Promise<readonly ToolSchemaSearchResult[]> {
    if (this.deps.getMcpServers().length === 0) {
      return [];
    }

    try {
      const inspections = await inspectConfiguredMcpServers(
        this.deps.getMcpServers(),
        this.deps.getNetworkPolicy(),
        undefined,
        this.deps.signal()
      );
      const selected = selectedToolNames(query);
      const usedNames = new Set(toolDefinitions.map((tool) => tool.name));
      const results: ToolSchemaSearchResult[] = [];
      for (const inspection of inspections) {
        if (inspection.error || !inspection.status.valid || !inspection.status.enabled) {
          continue;
        }
        for (const tool of inspection.tools) {
          const functionName = mcpFunctionName(inspection.status.id, tool.name, usedNames);
          usedNames.add(functionName);
          const score = scoreToolSearch(query, selected, functionName, tool.description, ["mcp", inspection.status.id, tool.name]);
          if (score <= 0) {
            continue;
          }
          results.push({
            name: functionName,
            score,
            content: formatMcpToolSchemaSearchResult(functionName, inspection.status.id, tool)
          });
        }
      }
      return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(limit, 8));
    } catch {
      return [];
    }
  }
}
