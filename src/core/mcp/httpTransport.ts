import { assertUrlAllowed } from "../networkPolicy";
import { SseParser } from "../sseParser";
import { McpServerConfig, NetworkPolicy } from "../types";
import { mcpHttpHeaders } from "./httpHeaders";
import { parseJsonRpc, responseWithId } from "./jsonRpc";
import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from "./types";
import { requestId, safeResponseText, truncate, withoutUndefined } from "./util";

// Streamable HTTP MCP transport (the modern spec): one POST per request, an optional session id echoed
// back via the mcp-session-id header, and a response body that is either plain JSON or an SSE stream.
export class StreamableHttpMcpTransport implements McpTransport {
  private readonly server: McpServerConfig;
  private readonly policy: NetworkPolicy;
  private sessionId: string | undefined;

  constructor(server: McpServerConfig, policy: NetworkPolicy) {
    this.server = server;
    this.policy = policy;
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = requestId();
    return this.send({ jsonrpc: "2.0", id, method, params }, id, signal);
  }

  async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params }, undefined, signal);
  }

  close(): void {
    // Streamable HTTP does not hold a persistent local process in this adapter.
  }

  private async send(message: JsonRpcRequest, responseId: string | undefined, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (!this.server.url) {
      throw new Error("MCP HTTP server is missing a URL.");
    }
    assertUrlAllowed(this.server.url, this.policy);
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: mcpHttpHeaders(this.server, message.method, message.params, this.sessionId),
      redirect: "error",
      body: JSON.stringify(withoutUndefined(message)),
      signal
    });
    const nextSession = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (nextSession) {
      this.sessionId = nextSession;
    }
    if (response.status === 202 && !responseId) {
      return {};
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP request failed with ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 2000)}`);
    }
    if (!responseId) {
      return {};
    }
    return responseFromHttp(response, responseId);
  }
}

async function responseFromHttp(response: Response, id: string): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseResponse(response, id);
  }
  const parsed = parseJsonRpc(await response.text());
  const matched = responseWithId(parsed, id);
  if (!matched) {
    throw new Error("MCP response did not include the expected JSON-RPC id.");
  }
  return matched;
}

async function readSseResponse(response: Response, id: string): Promise<JsonRpcResponse> {
  if (!response.body) {
    throw new Error("MCP SSE response did not include a body.");
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
      const matched = responseWithId(parseJsonRpc(event.data), id);
      if (matched) {
        return matched;
      }
    }
  }
  for (const event of parser.flush()) {
    const matched = responseWithId(parseJsonRpc(event.data), id);
    if (matched) {
      return matched;
    }
  }
  throw new Error("MCP SSE response ended before the expected JSON-RPC response.");
}
