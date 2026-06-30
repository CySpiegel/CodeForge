import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { AgentUiEvent } from "../../src/agent/agentController";
import { AnthropicMessagesProvider } from "../../src/core/anthropicAdapter";
import { createControllerHarness } from "../harness/agentControllerHarness";

// End-to-end (controller-level) proof of the full Anthropic agentic loop: AgentController drives the
// REAL AnthropicMessagesProvider over HTTP against a mock Anthropic server that streams native SSE.
// Turn 1 the model calls a read-only tool; CodeForge executes it and sends the result back; turn 2 the
// model answers. This validates the round trip the unit tests can't: a CodeForge tool result becoming a
// proper Anthropic `tool_result` block on the next request, plus the system-prompt hoist and tool
// offering on the wire.

function sse(events: ReadonlyArray<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

const TURN1_TOOL_USE = sse([
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 50 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_loop1", name: "list_files", input: {} } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"limit\":10}" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } } },
  { event: "message_stop", data: { type: "message_stop" } }
]);

const TURN2_TEXT = sse([
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 90 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Listed the workspace files." } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } } },
  { event: "message_stop", data: { type: "message_stop" } }
]);

interface AnthropicBody {
  readonly system?: string;
  readonly max_tokens?: number;
  readonly messages?: ReadonlyArray<{ role: string; content: unknown }>;
  readonly tools?: ReadonlyArray<{ name: string }>;
}

function hasToolResult(body: AnthropicBody): boolean {
  return (body.messages ?? []).some((m) =>
    Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "tool_result"));
}

test("AgentController drives a full Anthropic tool loop over HTTP and round-trips the tool result", async () => {
  const messageRequests: AnthropicBody[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-test", max_input_tokens: 200000, max_tokens: 8192 }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as AnthropicBody;
      messageRequests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(hasToolResult(body) ? TURN2_TEXT : TURN1_TOOL_USE);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const provider = new AnthropicMessagesProvider(
      { id: "anthropic", label: "Anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" },
      { allowlist: [] }
    );
    const harness = createControllerHarness({
      mode: "ask",
      files: { "README.md": "# CodeForge\n", "src/index.ts": "export const value = 1;\n" },
      responses: [],
      liveProvider: provider,
      configuredModel: "claude-test"
    });

    await harness.controller.sendPrompt("List the workspace files.");

    // Two model turns hit the wire.
    assert.equal(messageRequests.length, 2, "two /v1/messages turns");

    // Turn 1 carried the hoisted system prompt, a bounded max_tokens, and offered the list_files tool.
    const turn1 = messageRequests[0];
    assert.equal(typeof turn1.system, "string");
    assert.ok((turn1.system ?? "").length > 0, "system prompt hoisted to the top-level param");
    assert.ok((turn1.max_tokens ?? 0) > 0, "max_tokens always present");
    assert.ok((turn1.tools ?? []).some((t) => t.name === "list_files"), "list_files offered");

    // Turn 2 carried the CodeForge tool result back as an Anthropic tool_result block keyed to the
    // turn-1 tool_use id — the round trip the mapper has to get right.
    const turn2 = messageRequests[1];
    const resultTurn = (turn2.messages ?? []).find((m) =>
      Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "tool_result"));
    assert.ok(resultTurn, "turn 2 has a user message containing a tool_result");
    const block = (resultTurn!.content as ReadonlyArray<{ type: string; tool_use_id?: string }>)
      .find((b) => b.type === "tool_result");
    assert.equal(block?.tool_use_id, "toolu_loop1");

    // The tool executed and the model's final answer came through.
    assertToolCompleted(harness.events, "list_files");
    assertAssistantMessage(harness.events, /Listed the workspace files\./);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function assertToolCompleted(events: readonly AgentUiEvent[], name: string): void {
  assert.ok(
    events.some((event) => event.type === "toolUse" && event.toolUse.name === name && event.toolUse.status === "completed"),
    `${name} should complete`
  );
}

function assertAssistantMessage(events: readonly AgentUiEvent[], pattern: RegExp): void {
  assert.ok(
    events.some((event) => event.type === "message" && event.role === "assistant" && pattern.test(event.text)),
    `assistant message should match ${pattern}`
  );
}
