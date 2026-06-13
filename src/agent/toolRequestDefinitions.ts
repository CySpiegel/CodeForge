import { AgentMode, ChatMessage, McpServerConfig, NetworkPolicy, ToolDefinition } from "../core/types";
import {
  coreAgentToolNames,
  coreReadOnlyToolNames,
  discoveredCodeForgeToolNames,
  discoveredMcpToolNames,
  mcpFunctionName,
  McpToolBinding,
  mcpToolParameters,
  toolDefinitionsForAgentMode
} from "../core/toolDiscovery";
import { inspectConfiguredMcpServers } from "../core/mcpClient";

// Narrow config surface this computation needs — satisfied structurally by the ConfigPort.
export interface ToolRequestConfig {
  getMcpServers(): readonly McpServerConfig[];
  getNetworkPolicy(): NetworkPolicy;
}

// Builds the tool-definition list for a single model request: the mode-allowed core tools that have
// actually been loaded (via tool_search), plus — in agent mode — any discovered MCP tools, binding each
// generated MCP function name back to its server/tool. A self-contained request-prep computation lifted
// out of the run loop; the controller passes its live message log and config.
export async function buildToolDefinitionsForRequest(
  mode: AgentMode,
  mcpToolBindings: Map<string, McpToolBinding>,
  messages: readonly ChatMessage[],
  config: ToolRequestConfig,
  signal: AbortSignal
): Promise<readonly ToolDefinition[]> {
  const allowedTools = [...toolDefinitionsForAgentMode(mode)];
  const loadedToolNames = new Set(mode === "agent" ? coreAgentToolNames : coreReadOnlyToolNames);
  for (const toolName of discoveredCodeForgeToolNames(messages)) {
    loadedToolNames.add(toolName);
  }
  const baseTools = allowedTools.filter((tool) => loadedToolNames.has(tool.name));
  if (mode !== "agent" || config.getMcpServers().length === 0) {
    return baseTools;
  }

  const loadedMcpToolNames = discoveredMcpToolNames(messages);
  if (loadedMcpToolNames.size === 0) {
    return baseTools;
  }

  try {
    const inspections = await inspectConfiguredMcpServers(
      config.getMcpServers(),
      config.getNetworkPolicy(),
      undefined,
      signal
    );
    const usedNames = new Set(baseTools.map((tool) => tool.name));
    const mcpTools: ToolDefinition[] = [];
    for (const inspection of inspections) {
      if (inspection.error || !inspection.status.valid || !inspection.status.enabled) {
        continue;
      }
      for (const tool of inspection.tools) {
        const name = mcpFunctionName(inspection.status.id, tool.name, usedNames);
        usedNames.add(name);
        if (!loadedMcpToolNames.has(name)) {
          continue;
        }
        mcpToolBindings.set(name, { serverId: inspection.status.id, toolName: tool.name });
        mcpTools.push({
          name,
          description: [
            `Call MCP tool ${tool.name} on configured server ${inspection.status.id}.`,
            tool.description
          ].filter((line): line is string => Boolean(line)).join(" "),
          parameters: mcpToolParameters(tool.inputSchema)
        });
      }
    }
    return [...baseTools, ...mcpTools];
  } catch {
    return baseTools;
  }
}
