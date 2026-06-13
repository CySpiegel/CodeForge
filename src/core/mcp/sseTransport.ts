import { assertUrlAllowed } from "../networkPolicy";
import { SseEvent, SseParser } from "../sseParser";
import { McpServerConfig, NetworkPolicy } from "../types";
import { mcpHttpHeaders } from "./httpHeaders";
import { parseJsonRpc, responseWithId } from "./jsonRpc";
import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from "./types";
import { combinedSignal, requestId, safeResponseText, throwIfAborted, truncate, withoutUndefined } from "./util";

// Legacy HTTP+SSE MCP transport (the pre-streamable spec): open a long-lived SSE stream, read the
// announced message endpoint from it, then POST requests to that endpoint and correlate responses by
// JSON-RPC id off the same stream.
export class LegacySseMcpTransport implements McpTransport {
  private readonly server: McpServerConfig;
  private readonly policy: NetworkPolicy;
  private readonly abort = new AbortController();
  private readonly decoder = new TextDecoder();
  private readonly parser = new SseParser();
  private readonly queuedEvents: SseEvent[] = [];
  private iterator: AsyncIterator<Uint8Array> | undefined;
  private messageEndpoint: string | undefined;

  private constructor(server: McpServerConfig, policy: NetworkPolicy) {
    this.server = server;
    this.policy = policy;
  }

  static async connect(server: McpServerConfig, policy: NetworkPolicy, signal?: AbortSignal): Promise<LegacySseMcpTransport> {
    const transport = new LegacySseMcpTransport(server, policy);
    await transport.open(signal);
    return transport;
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = requestId();
    await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    return this.readResponse(id, signal);
  }

  async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, signal);
  }

  close(): void {
    this.abort.abort();
  }

  private async open(signal?: AbortSignal): Promise<void> {
    if (!this.server.url) {
      throw new Error("MCP SSE server is missing a URL.");
    }
    assertUrlAllowed(this.server.url, this.policy);
    const response = await fetch(this.server.url, {
      headers: {
        accept: "text/event-stream",
        ...(this.server.headers ?? {})
      },
      redirect: "error",
      signal: combinedSignal(this.abort.signal, signal)
    });
    if (!response.ok || !response.body) {
      throw new Error(`MCP SSE connection failed with ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 2000)}`);
    }
    this.iterator = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    while (!this.messageEndpoint) {
      const event = await this.nextEvent(signal);
      if (event.event === "endpoint" || event.data.startsWith("/") || /^https?:\/\//i.test(event.data)) {
        this.messageEndpoint = new URL(event.data, this.server.url).toString();
      }
    }
    assertUrlAllowed(this.messageEndpoint, this.policy);
  }

  private async post(message: JsonRpcRequest, signal?: AbortSignal): Promise<void> {
    if (!this.messageEndpoint) {
      throw new Error("MCP SSE message endpoint was not announced by the server.");
    }
    const response = await fetch(this.messageEndpoint, {
      method: "POST",
      headers: mcpHttpHeaders(this.server, message.method, message.params),
      redirect: "error",
      body: JSON.stringify(withoutUndefined(message)),
      signal
    });
    if (!response.ok) {
      throw new Error(`MCP SSE POST failed with ${response.status} ${response.statusText}: ${truncate(await safeResponseText(response), 2000)}`);
    }
  }

  private async readResponse(id: string, signal?: AbortSignal): Promise<JsonRpcResponse> {
    while (true) {
      const event = await this.nextEvent(signal);
      const parsed = parseJsonRpc(event.data);
      const response = responseWithId(parsed, id);
      if (response) {
        return response;
      }
    }
  }

  private async nextEvent(signal?: AbortSignal): Promise<SseEvent> {
    throwIfAborted(signal);
    if (this.queuedEvents.length > 0) {
      return this.queuedEvents.shift()!;
    }
    if (!this.iterator) {
      throw new Error("MCP SSE stream is not open.");
    }
    while (true) {
      const next = await this.iterator.next();
      if (next.done) {
        throw new Error("MCP SSE stream closed before a response was received.");
      }
      this.queuedEvents.push(...this.parser.push(this.decoder.decode(next.value, { stream: true })));
      if (this.queuedEvents.length > 0) {
        return this.queuedEvents.shift()!;
      }
    }
  }
}
