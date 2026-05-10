import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createInterface, Interface as ReadlineInterface } from "readline";
import { assertUrlAllowed } from "./networkPolicy";
import { SseEvent, SseParser } from "./sseParser";
import { McpCallToolAction, McpServerConfig, NetworkPolicy } from "./types";

const protocolVersion = "2025-06-18";
const defaultRequestTimeoutMs = 30_000;

interface JsonRpcResponse {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string;
  readonly method: string;
  readonly params?: unknown;
}

interface McpTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse>;
  notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface McpServerStatus {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: McpServerConfig["transport"];
  readonly target: string;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpServerInspection {
  readonly status: McpServerStatus;
  readonly serverInfo?: unknown;
  readonly tools: readonly McpToolSummary[];
  readonly resources: readonly McpResourceSummary[];
  readonly error?: string;
}

export interface McpResourceReadResult {
  readonly serverId: string;
  readonly uri: string;
  readonly label: string;
  readonly content: string;
}

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

class StreamableHttpMcpTransport implements McpTransport {
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

class LegacySseMcpTransport implements McpTransport {
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

class StdioMcpTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<string, {
    readonly resolve: (response: JsonRpcResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private stderr = "";
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = truncate(`${this.stderr}${chunk.toString("utf8")}`, 4000);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code, signal) => {
      if (!this.closed) {
        this.rejectAll(new Error(`MCP stdio server exited with ${code ?? signal ?? "unknown"}${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
      }
    });
  }

  static start(server: McpServerConfig, signal?: AbortSignal): StdioMcpTransport {
    if (!server.command) {
      throw new Error("MCP stdio server requires a command.");
    }
    throwIfAborted(signal);
    const child = spawn(server.command, [...server.args ?? []], {
      cwd: server.cwd?.trim() || process.cwd(),
      windowsHide: true,
      env: mcpEnvironment(process.env)
    });
    const transport = new StdioMcpTransport(child);
    if (signal?.aborted) {
      transport.close();
      throw new Error("MCP stdio start was cancelled.");
    }
    signal?.addEventListener("abort", () => transport.close(), { once: true });
    return transport;
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = requestId();
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request ${method} timed out.`));
      }, defaultRequestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (signal?.aborted) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP stdio request ${method} was cancelled.`));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.closed = true;
    this.lines.close();
    this.rejectAll(new Error("MCP stdio transport closed."));
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private write(message: JsonRpcRequest): void {
    if (this.child.stdin.destroyed) {
      throw new Error("MCP stdio server stdin is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(withoutUndefined(message))}\n`, "utf8");
  }

  private handleLine(line: string): void {
    const parsed = parseJsonRpc(line);
    if (isJsonRpcResponseArray(parsed)) {
      for (const item of parsed) {
        this.resolveResponse(item);
      }
      return;
    }
    this.resolveResponse(parsed);
  }

  private resolveResponse(response: JsonRpcResponse): void {
    if (response.id === undefined || response.id === null) {
      return;
    }
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(response.id));
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
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

function responseWithId(parsed: JsonRpcResponse | readonly JsonRpcResponse[], id: string): JsonRpcResponse | undefined {
  if (isJsonRpcResponseArray(parsed)) {
    return parsed.find((item) => String(item.id) === id);
  }
  return String(parsed.id) === id ? parsed : undefined;
}

function isJsonRpcResponseArray(value: JsonRpcResponse | readonly JsonRpcResponse[]): value is readonly JsonRpcResponse[] {
  return Array.isArray(value);
}

function checkedResult(response: JsonRpcResponse): unknown {
  if (response.error) {
    const code = response.error.code === undefined ? "" : ` ${response.error.code}`;
    throw new Error(`MCP tool error${code}: ${response.error.message ?? "Unknown MCP error"}${response.error.data === undefined ? "" : `\n${safeJson(response.error.data)}`}`);
  }
  return response.result;
}

function parseJsonRpc(text: string): JsonRpcResponse | readonly JsonRpcResponse[] {
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse | readonly JsonRpcResponse[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed && typeof parsed === "object" ? parsed : { error: { message: "MCP response was not a JSON-RPC object." } };
  } catch (error) {
    return { error: { message: `MCP response was not valid JSON: ${errorMessage(error)}` } };
  }
}

function parseMcpTools(result: unknown): readonly McpToolSummary[] {
  if (!isObject(result) || !Array.isArray(result.tools)) {
    return [];
  }
  return result.tools
    .map((tool): McpToolSummary | undefined => {
      if (!isObject(tool) || typeof tool.name !== "string" || !tool.name.trim()) {
        return undefined;
      }
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema
      };
    })
    .filter((tool): tool is McpToolSummary => Boolean(tool));
}

function parseMcpResources(result: unknown): readonly McpResourceSummary[] {
  if (!isObject(result) || !Array.isArray(result.resources)) {
    return [];
  }
  return result.resources
    .map((resource): McpResourceSummary | undefined => {
      if (!isObject(resource) || typeof resource.uri !== "string" || !resource.uri.trim()) {
        return undefined;
      }
      return {
        uri: resource.uri,
        name: typeof resource.name === "string" ? resource.name : undefined,
        description: typeof resource.description === "string" ? resource.description : undefined,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined
      };
    })
    .filter((resource): resource is McpResourceSummary => Boolean(resource));
}

function formatMcpResult(result: unknown): string {
  if (isObject(result) && Array.isArray(result.content)) {
    const text = result.content
      .map((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : safeJson(item))
      .join("\n");
    return truncate(text || safeJson(result), 50000);
  }
  return truncate(safeJson(result), 50000);
}

function formatMcpResourceContents(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.contents)) {
    return truncate(safeJson(result), 50000);
  }

  const parts = result.contents.map((item): string => {
    if (!isObject(item)) {
      return safeJson(item);
    }
    const uri = typeof item.uri === "string" ? item.uri : undefined;
    const mime = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const header = [uri, mime].filter(Boolean).join(" | ");
    if (typeof item.text === "string") {
      return `${header ? `${header}\n` : ""}${item.text}`;
    }
    if (typeof item.blob === "string") {
      return `${header ? `${header}\n` : ""}[Binary MCP resource omitted: ${item.blob.length} base64 characters]`;
    }
    return safeJson(item);
  });
  return truncate(parts.join("\n\n"), 50000);
}

function mcpError(action: McpCallToolAction, message: string): string {
  return `mcp_call_tool ${action.serverId}/${action.toolName}\n\n<tool_use_error>Error: ${message}</tool_use_error>`;
}

function mcpHttpHeaders(server: McpServerConfig, method: string, params: unknown, sessionId?: string): Record<string, string> {
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

function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return controller.signal;
  }
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function requestId(): string {
  return `codeforge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("MCP request was cancelled.");
  }
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT"
  ];
  const env: NodeJS.ProcessEnv = {
    CODEFORGE: "1",
    NO_COLOR: "1"
  };
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
