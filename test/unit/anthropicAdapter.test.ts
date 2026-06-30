import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicMessagesProvider } from "../../src/core/anthropicAdapter";
import { LlmStreamEvent } from "../../src/core/types";

// Build a text/event-stream Response body from Anthropic SSE events.
function sseResponse(events: ReadonlyArray<{ event: string; data: unknown }>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const e of events) {
        controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function provider(apiKey = "sk-ant-test"): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider(
    { id: "anthropic", label: "Anthropic", baseUrl: "http://127.0.0.1:4010", apiKey },
    { allowlist: [] }
  );
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

const TEXT_STREAM = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
  { event: "message_stop", data: { type: "message_stop" } }
];

test("streams text_delta as content and merges usage from message_start + message_delta", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(TEXT_STREAM);
  try {
    const events = await collect(provider().streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }));
    const text = events.filter((e) => e.type === "content").map((e) => (e as { text: string }).text).join("");
    assert.equal(text, "Hello");
    const usage = events.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.deepEqual(usage.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.equal(events[events.length - 1].type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reassembles input_json_delta fragments into a single terminal toolCalls event", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 20 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } } },
    { event: "message_stop", data: { type: "message_stop" } }
  ]);
  try {
    const events = await collect(provider().streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "read a.ts" }] }));
    const toolEvents = events.filter((e) => e.type === "toolCalls");
    assert.equal(toolEvents.length, 1, "exactly one terminal toolCalls event");
    const terminal = toolEvents[0];
    assert.ok(terminal.type === "toolCalls");
    assert.deepEqual([...terminal.toolCalls], [{ id: "toolu_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }]);
    assert.ok(events.some((e) => e.type === "progress"), "input_json_delta yields progress");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("thinking_delta surfaces as a reasoning event; ping is tolerated as progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
    { event: "ping", data: { type: "ping" } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } } },
    { event: "message_stop", data: { type: "message_stop" } }
  ]);
  try {
    const events = await collect(provider().streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }));
    assert.ok(events.some((e) => e.type === "reasoning" && e.text === "pondering"));
    assert.ok(events.some((e) => e.type === "content" && e.text === "answer"));
    assert.equal(events[events.length - 1].type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an error SSE event throws out of the turn", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
    { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "overloaded" } } }
  ]);
  try {
    await assert.rejects(
      collect(provider().streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] })),
      /Anthropic stream error/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function captureRequest(
  baseUrl: string,
  apiKey: string,
  allowlist: readonly string[]
): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body))
    };
    return sseResponse(TEXT_STREAM);
  };
  try {
    const p = new AnthropicMessagesProvider({ id: "p", label: "p", baseUrl, apiKey }, { allowlist });
    await collect(p.streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], maxTokens: 4096 }));
    if (!captured) {
      throw new Error("fetch was not called");
    }
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("official Anthropic host authenticates with x-api-key (never Authorization) and always sends max_tokens", async () => {
  const captured = await captureRequest("https://api.anthropic.com", "sk-ant-secret", ["https://api.anthropic.com"]);
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.headers.get("x-api-key"), "sk-ant-secret");
  assert.equal(captured.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(captured.headers.get("authorization"), null);
  assert.equal(captured.body.max_tokens, 4096);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.temperature, undefined);
});

test("an Anthropic-compatible gateway (AskSage) authenticates with Authorization: Bearer and keeps its base path", async () => {
  const captured = await captureRequest("https://api.asksage.ai/server/anthropic", "asksage-token", ["https://api.asksage.ai"]);
  // base path preserved: endpoint is <base>/v1/messages, NOT .../server/v1/messages
  assert.equal(captured.url, "https://api.asksage.ai/server/anthropic/v1/messages");
  assert.equal(captured.headers.get("authorization"), "Bearer asksage-token");
  assert.equal(captured.headers.get("x-api-key"), null);
  assert.equal(captured.headers.get("anthropic-version"), "2023-06-01");
});

test("max_tokens is always present even when the request omits it (Anthropic requires it)", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return sseResponse(TEXT_STREAM);
  };
  try {
    await collect(provider().streamChat({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(typeof body?.max_tokens, "number");
    assert.ok((body?.max_tokens as number) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a #anthropic fragment on a local base URL is dropped, posting to <origin>/v1/messages", async () => {
  const captured = await captureRequest("http://127.0.0.1:4010#anthropic", "lmstudio", []);
  assert.equal(captured.url, "http://127.0.0.1:4010/v1/messages");
  // a local/proxy host gets Bearer auth (LM Studio accepts it)
  assert.equal(captured.headers.get("authorization"), "Bearer lmstudio");
});

test("a trailing /v1 on the base URL is collapsed so endpoints are not doubled", async () => {
  const captured = await captureRequest("https://api.anthropic.com/v1", "sk-ant", ["https://api.anthropic.com"]);
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
});

test("inspectEndpoint returns the Anthropic backend and a non-empty catalogue even when /v1/models fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 401 });
  try {
    const inspection = await provider().inspectEndpoint();
    assert.equal(inspection.backend, "anthropic");
    assert.equal(inspection.backendLabel, "Anthropic Messages API");
    assert.ok(inspection.models.some((m) => m.id === "claude-opus-4-8"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inspectEndpoint parses a /v1/models listing and filters out embedding models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", max_input_tokens: 1000000, max_tokens: 128000 },
      { id: "text-embedding-nomic-embed-text-v1.5" }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const models = (await provider().inspectEndpoint()).models;
    assert.ok(models.some((m) => m.id === "claude-opus-4-8"));
    assert.ok(!models.some((m) => m.id.includes("embed")), "embedding model filtered out");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeCapabilities reports streaming + native tool calls with no HTTP probe", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  try {
    const caps = await provider().probeCapabilities();
    assert.deepEqual(caps, { streaming: true, modelListing: true, nativeToolCalls: true });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
