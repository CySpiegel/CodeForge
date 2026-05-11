import test from "node:test";
import assert from "node:assert/strict";
import { ensureOpenAiToolResultPairing, OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";

test("streams OpenAI-compatible chat completion chunks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    const chunks: string[] = [];
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "content") {
        chunks.push(event.text);
      }
    }
    assert.equal(chunks.join(""), "hello");
    assert.deepEqual(await provider.listModels(), ["local-model"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops streaming when OpenAI done event arrives even if the response body stays open", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );

    const events = await Promise.race([
      (async () => {
        const result = [];
        for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
          result.push(event);
        }
        return result;
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("streamChat did not stop at [DONE]")), 250);
      })
    ]);

    assert.equal(events.filter((event) => event.type === "content").map((event) => event.text).join(""), "done");
    assert.equal(events[events.length - 1]?.type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats streamed reasoning chunks as model progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    const events = [];
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "progress"), true);
    assert.equal(events.some((event) => event.type === "toolCalls"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serializes assistant tool calls and tool results", async () => {
  const originalFetch = globalThis.fetch;
  let postedBody = "";
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    postedBody = String(init?.body ?? "");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    for await (const event of provider.streamChat({
      model: "local-model",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }]
        },
        { role: "tool", content: "read_file README.md\n\n# CodeForge", name: "read_file", toolCallId: "call-1" }
      ]
    })) {
      assert.ok(event.type);
    }

    const body = JSON.parse(postedBody) as { readonly messages: readonly Record<string, unknown>[] };
    assert.deepEqual(body.messages[0].tool_calls, [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
      }
    ]);
    assert.equal(body.messages[1].tool_call_id, "call-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repairs interrupted assistant tool-call turns before OpenAI requests", () => {
  const repaired = ensureOpenAiToolResultPairing([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-a", name: "edit_file", argumentsJson: "{\"path\":\"a.ts\"}" },
        { id: "call-b", name: "edit_file", argumentsJson: "{\"path\":\"b.ts\"}" }
      ]
    },
    { role: "tool", content: "edit_file a.ts\n\nEdited a.ts", name: "edit_file", toolCallId: "call-a" },
    { role: "user", content: "continue" }
  ]);

  assert.equal(repaired.length, 4);
  assert.equal(repaired[1]?.role, "tool");
  assert.equal(repaired[1]?.toolCallId, "call-a");
  assert.equal(repaired[2]?.role, "tool");
  assert.equal(repaired[2]?.toolCallId, "call-b");
  assert.match(repaired[2]?.content ?? "", /interrupted before CodeForge produced a result/);
  assert.equal(repaired[3]?.role, "user");
});

test("reads context metadata from OpenAI API model discovery", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "google/gemma-4-e4b", object: "model", type: "vlm", max_context_length: 131072 },
          { id: "text-embedding-nomic-embed-text-v1.5", object: "model", type: "embeddings", max_context_length: 2048 }
        ]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:1234" },
      { allowlist: [] }
    );
    const inspection = await provider.inspectEndpoint();
    assert.equal(inspection.backendLabel, "OpenAI API compatible");
    assert.deepEqual(inspection.models, [
      {
        id: "google/gemma-4-e4b",
        type: "vlm",
        contextLength: 131072,
        maxOutputTokens: undefined,
        supportsReasoning: undefined
      }
    ]);
    assert.deepEqual(await provider.listModels(), ["google/gemma-4-e4b"]);
    assert.equal(requestedUrls.some((url) => url.endsWith("/api/v0/models")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats accepted OpenAI tool schemas as native tool support", async () => {
  const originalFetch = globalThis.fetch;
  const postedBodies: unknown[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "ok", tool_calls: [] },
          finish_reason: "stop"
        }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    const capabilities = await provider.probeCapabilities("local-model");
    assert.equal(capabilities.nativeToolCalls, true);
    assert.equal(capabilities.modelListing, true);
    assert.equal((postedBodies[0] as { readonly tool_choice?: string }).tool_choice, "none");
    assert.ok(Array.isArray((postedBodies[0] as { readonly tools?: unknown[] }).tools));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries tool support probe without tool_choice when an endpoint rejects it", async () => {
  const originalFetch = globalThis.fetch;
  const postedBodies: unknown[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    postedBodies.push(body);
    if (body.tool_choice) {
      return new Response("unsupported tool_choice", { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "o" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    const capabilities = await provider.probeCapabilities("local-model");
    assert.equal(capabilities.nativeToolCalls, true);
    assert.equal(postedBodies.length, 2);
    assert.equal((postedBodies[1] as { readonly tool_choice?: string }).tool_choice, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
