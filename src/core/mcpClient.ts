import { errorMessage } from "./guards";
import { StreamableHttpMcpTransport } from "./mcp/httpTransport";
import { checkedResult } from "./mcp/jsonRpc";
import { formatMcpResourceContents, formatMcpResult, mcpError, parseMcpResources, parseMcpTools } from "./mcp/responseFormat";
import { LegacySseMcpTransport } from "./mcp/sseTransport";
import { StdioMcpTransport } from "./mcp/stdioTransport";
import type { JsonRpcResponse, McpResourceReadResult, McpServerInspection, McpServerStatus, McpTransport } from "./mcp/types";
import { isSafeId } from "./mcp/util";
import { assertUrlAllowed } from "./networkPolicy";
import { McpCallToolAction, McpServerConfig, NetworkPolicy } from "./types";

const protocolVersion = "2025-06-18";

// Public types re-exported so existing `from "../core/mcpClient"` importers (toolDiscovery,
// mcpCoordinator, agentController, doctorService, toolSchemaService) are unaffected by the split.
export type { McpResourceReadResult, McpResourceSummary, McpServerInspection, McpServerStatus, McpToolSummary } from "./mcp/types";

export function configuredMcpServerStatuses(servers: readonly McpServerConfig[], policy: NetworkPolicy): readonly McpServerStatus[] {
  return servers.map((server) => validateMcpServer(server, policy));
}

export async function inspectConfiguredMcpServers(
  servers: readonly McpServerConfig[],
  policy: NetworkPolicy,
  serverId?: string,
  signal?: AbortSignal
): Promise<readonly McpServerInspection[]> {
  const selected = serverId ? servers.filter((server) => server.id === serverId) : servers;
  if (serverId && selected.length === 0) {
    return [{
      status: {
        id: serverId,
        label: serverId,
        enabled: false,
        transport: "http",
        target: "",
        valid: false,
        reason: `No configured MCP server with id ${serverId}.`
      },
      tools: [],
      resources: [],
      error: `No configured MCP server with id ${serverId}.`
    }];
  }

  const inspections: McpServerInspection[] = [];
  for (const server of selected) {
    const status = validateMcpServer(server, policy);
    if (!status.valid || !status.enabled) {
      inspections.push({
        status,
        tools: [],
        resources: [],
        error: status.enabled ? status.reason : `MCP server ${server.id} is disabled.`
      });
      continue;
    }

    try {
      inspections.push(await withMcpTransport(server, policy, signal, async (transport) => {
        const initialized = await initializeMcp(transport, signal);
        const tools = parseMcpTools(checkedResult(await transport.request("tools/list", undefined, signal)));
        const resources = await transport.request("resources/list", undefined, signal)
          .then((response) => parseMcpResources(checkedResult(response)))
          .catch(() => []);
        return {
          status,
          serverInfo: initialized.result,
          tools,
          resources
        };
      }));
    } catch (error) {
      inspections.push({
        status,
        tools: [],
        resources: [],
        error: errorMessage(error)
      });
    }
  }
  return inspections;
}

export async function callConfiguredMcpTool(
  servers: readonly McpServerConfig[],
  policy: NetworkPolicy,
  action: McpCallToolAction,
  signal?: AbortSignal
): Promise<string> {
  const server = servers.find((item) => item.id === action.serverId);
  if (!server) {
    return mcpError(action, `No configured MCP server with id ${action.serverId}.`);
  }

  const status = validateMcpServer(server, policy);
  if (!status.valid) {
    return mcpError(action, status.reason ?? "MCP server configuration is invalid.");
  }
  if (!status.enabled) {
    return mcpError(action, `MCP server ${action.serverId} is disabled.`);
  }

  try {
    return await withMcpTransport(server, policy, signal, async (transport) => {
      await initializeMcp(transport, signal);
      const response = await transport.request("tools/call", {
        name: action.toolName,
        arguments: action.arguments ?? {}
      }, signal);
      return `mcp_call_tool ${action.serverId}/${action.toolName}\n\n${formatMcpResult(checkedResult(response))}`;
    });
  } catch (error) {
    return mcpError(action, errorMessage(error));
  }
}

export async function readConfiguredMcpResource(
  servers: readonly McpServerConfig[],
  policy: NetworkPolicy,
  serverId: string,
  uri: string,
  signal?: AbortSignal
): Promise<McpResourceReadResult> {
  const server = servers.find((item) => item.id === serverId);
  if (!server) {
    throw new Error(`No configured MCP server with id ${serverId}.`);
  }

  const status = validateMcpServer(server, policy);
  if (!status.valid) {
    throw new Error(status.reason ?? "MCP server configuration is invalid.");
  }
  if (!status.enabled) {
    throw new Error(`MCP server ${serverId} is disabled.`);
  }

  return withMcpTransport(server, policy, signal, async (transport) => {
    await initializeMcp(transport, signal);
    const response = await transport.request("resources/read", { uri }, signal);
    const content = formatMcpResourceContents(checkedResult(response));
    return {
      serverId,
      uri,
      label: `${server.label}: ${uri}`,
      content
    };
  });
}

async function withMcpTransport<T>(
  server: McpServerConfig,
  policy: NetworkPolicy,
  signal: AbortSignal | undefined,
  callback: (transport: McpTransport) => Promise<T>
): Promise<T> {
  const transport = await createMcpTransport(server, policy, signal);
  try {
    return await callback(transport);
  } finally {
    transport.close();
  }
}

async function createMcpTransport(server: McpServerConfig, policy: NetworkPolicy, signal?: AbortSignal): Promise<McpTransport> {
  if (server.transport === "stdio") {
    return StdioMcpTransport.start(server, signal);
  }
  if (server.transport === "sse") {
    return LegacySseMcpTransport.connect(server, policy, signal);
  }
  return new StreamableHttpMcpTransport(server, policy);
}

async function initializeMcp(transport: McpTransport, signal?: AbortSignal): Promise<JsonRpcResponse> {
  const initialized = await transport.request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: {
      name: "CodeForge",
      version: "0.0.1"
    }
  }, signal);
  await transport.notify("notifications/initialized", undefined, signal);
  return initialized;
}

function validateMcpServer(server: McpServerConfig, policy: NetworkPolicy): McpServerStatus {
  const base = {
    id: server.id,
    label: server.label,
    enabled: server.enabled !== false,
    transport: server.transport,
    target: server.url ?? server.command ?? ""
  };

  if (!isSafeId(server.id)) {
    return { ...base, valid: false, reason: "MCP server id must contain only letters, numbers, dots, underscores, or dashes." };
  }
  if (!server.label.trim()) {
    return { ...base, valid: false, reason: "MCP server label is required." };
  }
  if (server.enabled === false) {
    return { ...base, valid: true };
  }
  if (server.transport === "stdio") {
    return server.command?.trim()
      ? { ...base, valid: true }
      : { ...base, valid: false, reason: "MCP stdio server requires a command." };
  }
  if (server.transport === "http" || server.transport === "sse") {
    if (!server.url) {
      return { ...base, valid: false, reason: `MCP ${server.transport} server requires a URL.` };
    }
    try {
      assertUrlAllowed(server.url, policy);
      return { ...base, valid: true };
    } catch (error) {
      return { ...base, valid: false, reason: errorMessage(error) };
    }
  }
  return { ...base, valid: false, reason: `Unsupported MCP transport: ${String(server.transport)}.` };
}


