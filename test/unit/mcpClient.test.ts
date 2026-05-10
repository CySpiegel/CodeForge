import test from "node:test";
import assert from "node:assert/strict";
import { callConfiguredMcpTool, configuredMcpServerStatuses, inspectConfiguredMcpServers, readConfiguredMcpResource } from "../../src/core/mcpClient";
import { McpServerConfig } from "../../src/core/types";

test("validates MCP HTTP servers against offline network policy", () => {
  const statuses = configuredMcpServerStatuses(
    [{ id: "public", label: "Public", transport: "http", url: "https://api.example.com/mcp" }],
    { allowlist: [] }
  );

  assert.equal(statuses[0]?.valid, false);
  assert.match(statuses[0]?.reason ?? "", /Blocked network destination/);
});

test("does not call disabled MCP servers", async () => {
  const result = await callConfiguredMcpTool(
    [{ id: "local", label: "Local", enabled: false, transport: "http", url: "http://127.0.0.1:3000/mcp" }],
    { allowlist: [] },
    { type: "mcp_call_tool", serverId: "local", toolName: "tools.echo" }
  );

  assert.match(result, /<tool_use_error>/);
  assert.match(result, /disabled/);
});

test("posts JSON-RPC tools calls to configured local HTTP MCP servers", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const body = JSON.parse(String(init?.body));
    if (!body.id) {
      return new Response(undefined, { status: 202 });
    }
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "fake" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
  }) as typeof fetch;

  const servers: readonly McpServerConfig[] = [
    { id: "local", label: "Local", transport: "http", url: "http://127.0.0.1:3000/mcp" }
  ];

  try {
    const result = await callConfiguredMcpTool(
      servers,
      { allowlist: [] },
      { type: "mcp_call_tool", serverId: "local", toolName: "tools.echo", arguments: { message: "hi" } }
    );

    assert.match(result, /ok/);
    const last = calls[calls.length - 1];
    assert.equal(last?.input, "http://127.0.0.1:3000/mcp");
    const body = JSON.parse(String(last?.init?.body));
    assert.equal(body.method, "tools/call");
    assert.deepEqual(body.params, { name: "tools.echo", arguments: { message: "hi" } });
    assert.equal(last?.init?.redirect, "error");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("inspects tools and resources from a configured local HTTP MCP server", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.id) {
      return new Response(undefined, { status: 202 });
    }
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "tools.echo", description: "Echo" }] } }), { status: 200 });
    }
    if (body.method === "resources/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resources: [{ uri: "file:///notes.md", name: "Notes" }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const [inspection] = await inspectConfiguredMcpServers(
      [{ id: "local", label: "Local", transport: "http", url: "http://127.0.0.1:3000/mcp" }],
      { allowlist: [] }
    );

    assert.equal(inspection?.status.valid, true);
    assert.equal(inspection?.tools[0]?.name, "tools.echo");
    assert.equal(inspection?.resources[0]?.uri, "file:///notes.md");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reads configured MCP resources for explicit context attachment", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.id) {
      return new Response(undefined, { status: 202 });
    }
    if (body.method === "resources/read") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri: body.params.uri, mimeType: "text/markdown", text: "# Notes" }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const resource = await readConfiguredMcpResource(
      [{ id: "local", label: "Local", transport: "http", url: "http://127.0.0.1:3000/mcp" }],
      { allowlist: [] },
      "local",
      "file:///notes.md"
    );

    assert.equal(resource.label, "Local: file:///notes.md");
    assert.match(resource.content, /# Notes/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("validates configured stdio MCP servers without network policy checks", () => {
  const [status] = configuredMcpServerStatuses(
    [{ id: "stdio", label: "stdio", transport: "stdio", command: "local-mcp-server", args: ["--stdio"] }],
    { allowlist: [] }
  );

  assert.equal(status?.valid, true);
  assert.equal(status?.transport, "stdio");
});
