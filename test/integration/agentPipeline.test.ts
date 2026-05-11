import test from "node:test";
import assert from "node:assert/strict";
import { AgentUiEvent } from "../../src/agent/agentController";
import { createControllerHarness, toolCall, waitForEvent } from "../harness/agentControllerHarness";

test("/doctor runs diagnostics without consuming a chat completion", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: []
  });

  await harness.controller.sendPrompt("/doctor");

  const report = harness.events.find((event) => event.type === "message" && event.role === "system" && event.text.startsWith("CodeForge Doctor:"));
  assert.ok(report && report.type === "message");
  assert.match(report.text, /Endpoint\n\[pass\] Network policy:/);
  assert.match(report.text, /\[pass\] Model discovery: 1 model\(s\) returned by \/v1\/models\./);
  assert.match(report.text, /Workspace\n\[pass\] File discovery:/);
  assert.match(report.text, /Permissions\n\[pass\] Approval mode:/);
  assert.match(report.text, /Tooling\n\[pass\] Internal tools:/);
  assert.equal(harness.provider.requests.length, 0);
});

test("Ask mode executes read-only workspace tools and continues with tool results", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: [
      { toolCalls: [toolCall("list_files", { limit: 10 })] },
      { content: "Found README.md and src/index.ts." }
    ]
  });

  await harness.controller.sendPrompt("List the workspace files.");

  assertToolCompleted(harness.events, "list_files");
  assert.equal(harness.provider.requests.length, 2);
  assertToolWasOffered(harness.provider.requests[0].tools, "list_files");
  assertToolWasNotOffered(harness.provider.requests[0].tools, "write_file");
  assertAssistantMessage(harness.events, /Found README\.md and src\/index\.ts/);
});

test("Plan mode can load deferred code-intel schemas through tool_search", async () => {
  const harness = createControllerHarness({
    mode: "plan",
    files: {
      "src/index.ts": "export function add(a: number, b: number) { return a + b; }\n"
    },
    responses: [
      { toolCalls: [toolCall("tool_search", { query: "select:code_symbols" })] },
      { toolCalls: [toolCall("code_symbols", { path: "src/index.ts" })] },
      { content: "Plan: inspect symbols, then update callers if needed." }
    ]
  });

  await harness.controller.sendPrompt("Use code symbols and produce a short plan.");

  assertToolCompleted(harness.events, "tool_search");
  assertToolCompleted(harness.events, "code_symbols");
  assert.equal(harness.codeIntel.actions.length, 1);
  assertToolWasNotOffered(harness.provider.requests[0].tools, "code_symbols");
  assertToolWasOffered(harness.provider.requests[1].tools, "code_symbols");
});

test("Ask and Plan modes reject side-effect tools before execution", async () => {
  for (const mode of ["ask", "plan"] as const) {
    const harness = createControllerHarness({
      mode,
      files: { "README.md": "# CodeForge\n" },
      responses: [
        { toolCalls: [toolCall("write_file", { path: "NEW.md", content: "nope" })] },
        { content: "I cannot write in this mode." }
      ]
    });

    await harness.controller.sendPrompt("Try to write a file.");

    assertToolFailed(harness.events, "write_file");
    assert.equal(harness.diff.writes.length, 0);
    assert.equal(harness.workspace.files.has("NEW.md"), false);
  }
});

test("Agent mode executes write_file in full auto through the diff pipeline", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "SMOKE_AGENT.md", content: "Agent mode wrote this file." })] },
      { content: "Created SMOKE_AGENT.md." }
    ]
  });

  await harness.controller.sendPrompt("Create SMOKE_AGENT.md.");

  assertToolCompleted(harness.events, "write_file");
  assert.equal(harness.diff.writes.length, 1);
  assert.equal(harness.workspace.files.get("SMOKE_AGENT.md"), "Agent mode wrote this file.");
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /Verification:\n- No VS Code errors or warnings/.test(event.text)));
  assertAssistantMessage(harness.events, /Created SMOKE_AGENT\.md/);
});

test("pinned active files are attached to future prompt context", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "src/pinned.ts": "export const pinned = true;\n",
      "src/other.ts": "export const other = true;\n"
    },
    responses: [{ content: "Pinned context checked." }]
  });
  harness.workspace.activeDocument = { kind: "activeFile", label: "src/pinned.ts", content: "export const pinned = true;\n" };

  await harness.controller.sendPrompt("/pin");
  await harness.controller.sendPrompt("What file is pinned?");

  const contextMessage = harness.provider.requests[0].messages.find((message) => message.content.startsWith("CodeForge workspace context:"));
  assert.match(contextMessage?.content ?? "", /### file: Pinned: src\/pinned\.ts/);
  assert.ok(harness.events.some((event) => event.type === "state" && event.state.activeContext.pinnedFiles.includes("src/pinned.ts")));
});

test("inspector and audit track denied side-effect tools", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "NEW.md", content: "nope" })] },
      { content: "Denied as expected." }
    ]
  });

  await harness.controller.sendPrompt("Try to write.");

  const inspector = [...harness.events].reverse().find((event) => event.type === "inspector");
  assert.ok(inspector && inspector.type === "inspector");
  assert.ok(inspector.inspector.audit.some((entry) => entry.action === "write_file" && entry.outcome === "denied"));
  await harness.controller.sendPrompt("/audit");
  assert.ok(harness.events.some((event) => event.type === "message" && event.role === "system" && /Permission audit:/.test(event.text)));
});

test("controller memory APIs support add, edit, and remove", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: []
  });

  await harness.controller.addMemory("Prefer focused tests.", "workspace");
  const [memory] = await harness.memory.list();
  assert.equal(memory.text, "Prefer focused tests.");

  await harness.controller.updateMemory(memory.id, "Prefer narrow tests.", "user");
  const [updated] = await harness.memory.list();
  assert.equal(updated.text, "Prefer narrow tests.");
  assert.equal(updated.scope, "user");

  await harness.controller.removeMemory(updated.id);
  assert.equal((await harness.memory.list()).length, 0);
});

test("Manual approval pauses side effects, then approve resumes the model loop", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "APPROVED.md", content: "approved" })] },
      { content: "Approved write completed." }
    ]
  });

  await harness.controller.sendPrompt("Create APPROVED.md.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");
  assert.equal(approval.approval.action.type, "write_file");
  assert.equal(harness.diff.writes.length, 0);

  await harness.controller.approve(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Approved write completed/.test(event.text));

  assert.equal(harness.diff.writes.length, 1);
  assert.equal(harness.workspace.files.get("APPROVED.md"), "approved");
});

test("Invalid native tool calls return tool errors and allow a retry", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("does_not_exist", {})] },
      { toolCalls: [toolCall("read_file", { path: "README.md" })] },
      { content: "Recovered after the invalid tool call." }
    ]
  });

  await harness.controller.sendPrompt("Read the README.");

  assertToolFailed(harness.events, "does_not_exist");
  assertToolCompleted(harness.events, "read_file");
  assertAssistantMessage(harness.events, /Recovered after the invalid tool call/);
});

test("Concurrency-safe read tools in one assistant turn all execute", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: [
      {
        toolCalls: [
          toolCall("list_files", { limit: 10 }, "call-list"),
          toolCall("read_file", { path: "README.md" }, "call-read")
        ]
      },
      { content: "Both read tools completed." }
    ]
  });

  await harness.controller.sendPrompt("List files and read the README.");

  assertToolCompleted(harness.events, "list_files");
  assertToolCompleted(harness.events, "read_file");
  assertAssistantMessage(harness.events, /Both read tools completed/);
});

test("controller loads deferred MCP resource tools and lists configured resources", async () => {
  const fetchLog = withFakeMcpFetch();
  try {
    const harness = createControllerHarness({
      mode: "plan",
      mcpServers: [{ id: "local", label: "Local MCP", transport: "http", url: "http://127.0.0.1:3555/mcp" }],
      responses: [
        { toolCalls: [toolCall("tool_search", { query: "select:mcp_list_resources" })] },
        { toolCalls: [toolCall("mcp_list_resources", { serverId: "local" })] },
        { content: "MCP resources inspected." }
      ]
    });

    await harness.controller.sendPrompt("List local MCP resources.");

    assertToolCompleted(harness.events, "tool_search");
    assertToolCompleted(harness.events, "mcp_list_resources");
    assertToolWasNotOffered(harness.provider.requests[0].tools, "mcp_list_resources");
    assertToolWasOffered(harness.provider.requests[1].tools, "mcp_list_resources");
    assert.ok(fetchLog.methods.includes("resources/list"));
    assertAssistantMessage(harness.events, /MCP resources inspected/);
  } finally {
    fetchLog.restore();
  }
});

test("controller loads concrete MCP tool schemas and maps function calls back to server tools", async () => {
  const fetchLog = withFakeMcpFetch();
  try {
    const harness = createControllerHarness({
      mode: "agent",
      permissionMode: "fullAuto",
      mcpServers: [{ id: "local", label: "Local MCP", transport: "http", url: "http://127.0.0.1:3555/mcp" }],
      responses: [
        { toolCalls: [toolCall("tool_search", { query: "select:mcp__local__tools_echo" })] },
        { toolCalls: [toolCall("mcp__local__tools_echo", { message: "hi" })] },
        { content: "MCP tool call completed." }
      ]
    });

    await harness.controller.sendPrompt("Call the local MCP echo tool.");

    assertToolCompleted(harness.events, "tool_search");
    assertToolCompleted(harness.events, "mcp_call_tool");
    assertToolWasNotOffered(harness.provider.requests[0].tools, "mcp__local__tools_echo");
    assertToolWasOffered(harness.provider.requests[1].tools, "mcp__local__tools_echo");
    assert.deepEqual(fetchLog.toolCalls, [{ name: "tools.echo", arguments: { message: "hi" } }]);
    assertAssistantMessage(harness.events, /MCP tool call completed/);
  } finally {
    fetchLog.restore();
  }
});

function assertToolCompleted(events: readonly AgentUiEvent[], name: string): void {
  assert.ok(events.some((event) => event.type === "toolUse" && event.toolUse.name === name && event.toolUse.status === "completed"), `${name} should complete`);
}

function assertToolFailed(events: readonly AgentUiEvent[], name: string): void {
  assert.ok(events.some((event) => event.type === "toolUse" && event.toolUse.name === name && event.toolUse.status === "failed"), `${name} should fail`);
}

function assertAssistantMessage(events: readonly AgentUiEvent[], pattern: RegExp): void {
  assert.ok(events.some((event) => event.type === "message" && event.role === "assistant" && pattern.test(event.text)), `assistant message should match ${pattern}`);
}

function assertToolWasOffered(tools: readonly { readonly name: string }[] | undefined, name: string): void {
  assert.ok(tools?.some((tool) => tool.name === name), `${name} should be offered`);
}

function assertToolWasNotOffered(tools: readonly { readonly name: string }[] | undefined, name: string): void {
  assert.ok(!tools?.some((tool) => tool.name === name), `${name} should not be offered`);
}

function withFakeMcpFetch(): {
  readonly methods: string[];
  readonly toolCalls: Array<{ readonly name: string; readonly arguments: unknown }>;
  restore(): void;
} {
  const previousFetch = globalThis.fetch;
  const methods: string[] = [];
  const toolCalls: Array<{ readonly name: string; readonly arguments: unknown }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      readonly id?: string;
      readonly method?: string;
      readonly params?: { readonly name?: string; readonly arguments?: unknown; readonly uri?: string };
    };
    if (!body.id) {
      return new Response(undefined, { status: 202 });
    }
    methods.push(body.method ?? "");
    if (body.method === "initialize") {
      return jsonRpc(body.id, { serverInfo: { name: "fake-mcp" } });
    }
    if (body.method === "tools/list") {
      return jsonRpc(body.id, {
        tools: [
          {
            name: "tools.echo",
            description: "Echo a message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false
            }
          }
        ]
      });
    }
    if (body.method === "resources/list") {
      return jsonRpc(body.id, { resources: [{ uri: "file:///notes.md", name: "Notes", mimeType: "text/markdown" }] });
    }
    if (body.method === "resources/read") {
      return jsonRpc(body.id, { contents: [{ uri: body.params?.uri, mimeType: "text/markdown", text: "# Notes" }] });
    }
    if (body.method === "tools/call") {
      toolCalls.push({ name: body.params?.name ?? "", arguments: body.params?.arguments ?? {} });
      return jsonRpc(body.id, { content: [{ type: "text", text: "echo: ok" }] });
    }
    return jsonRpc(body.id, {});
  }) as typeof fetch;

  return {
    methods,
    toolCalls,
    restore() {
      globalThis.fetch = previousFetch;
    }
  };
}

function jsonRpc(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
