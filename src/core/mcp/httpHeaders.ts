import { isRecord as isObject } from "../guards";
import { McpServerConfig } from "../types";

// Build the HTTP headers for an MCP request: the server's configured headers plus the protocol headers
// (content-type, accept, mcp-method, the derived mcp-name, and an optional session id).
export function mcpHttpHeaders(server: McpServerConfig, method: string, params: unknown, sessionId?: string): Record<string, string> {
  const name = mcpName(method, params);
  return {
    ...(server.headers ?? {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {})
  };
}

// The mcp-name header value for methods that carry a primary subject (tool/prompt name, resource uri).
function mcpName(method: string, params: unknown): string | undefined {
  if (!isObject(params)) {
    return undefined;
  }
  if (method === "tools/call" || method === "prompts/get") {
    return typeof params.name === "string" ? params.name : undefined;
  }
  if (method === "resources/read") {
    return typeof params.uri === "string" ? params.uri : undefined;
  }
  return undefined;
}
