import test from "node:test";
import assert from "node:assert/strict";
import { ensureOpenAiToolResultPairing, OpenAiCompatibleProvider, resolveRequestMaxTokens, sanitizeToolArgumentsJson } from "../../src/core/openaiAdapter";

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

test("streamChat finishes on the include_usage terminal chunk without waiting for [DONE]", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/chat/completions")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
          // Spec terminal chunk: usage present, choices empty. The run must end here even though no
          // [DONE] follows — anything after it must not surface (this is the stuck-"Generating" fix).
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "LEAK" } }] })}\n\n`));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    const chunks: string[] = [];
    let usageTotal: number | undefined;
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "content") {
        chunks.push(event.text);
      }
      if (event.type === "usage") {
        usageTotal = event.usage.totalTokens;
      }
    }
    assert.equal(chunks.join(""), "ok");
    assert.equal(usageTotal, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat retries an HTTP 429 rate limit then streams the result", async () => {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/chat/completions")) {
      chatCalls++;
      if (chatCalls === 1) {
        // LiteLLM tokens-per-minute limit: transient 429 with a Retry-After hint (0s keeps the test fast).
        return new Response(JSON.stringify({ error: { message: "tokens per minute rate limit exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0" }
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] },
      { maxRateLimitRetries: 3 }
    );
    const chunks: string[] = [];
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "content") {
        chunks.push(event.text);
      }
    }
    assert.equal(chunks.join(""), "ok");
    assert.equal(chatCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat surfaces a rate-limit-aware error once 429 retries are exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/chat/completions")) {
      chatCalls++;
      return new Response("tokens per minute rate limit exceeded", { status: 429, headers: { "Retry-After": "0" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] },
      { maxRateLimitRetries: 1 }
    );
    await assert.rejects(
      (async () => {
        const seen: string[] = [];
        for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
          seen.push(event.type);
        }
      })(),
      /rate-limited \(HTTP 429\)/
    );
    // One initial attempt plus one retry (maxRateLimitRetries=1).
    assert.equal(chatCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat drops stream_options on a non-429 4xx and does not treat it as a rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        // Endpoint rejects the optional stream_options field with a 400 (not a rate limit).
        return new Response("unsupported field: stream_options", { status: 400 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] },
      { maxRateLimitRetries: 0 }
    );
    const chunks: string[] = [];
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "content") {
        chunks.push(event.text);
      }
    }
    assert.equal(chunks.join(""), "hi");
    assert.equal(bodies.length, 2);
    assert.ok("stream_options" in bodies[0], "first attempt includes stream_options");
    assert.ok(!("stream_options" in bodies[1]), "retry drops stream_options");
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

test("stops streaming when an OpenAI-compatible endpoint sends finish_reason without done", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
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
        setTimeout(() => reject(new Error("streamChat did not stop at finish_reason")), 250);
      })
    ]);

    assert.equal(events.filter((event) => event.type === "content").map((event) => event.text).join(""), "done");
    assert.equal(events[events.length - 1]?.type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops streaming after an OpenAI-compatible endpoint goes quiet after content", async () => {
  const originalFetch = globalThis.fetch;
  const originalGrace = process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
  process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = "25";
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}`));
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
        setTimeout(() => reject(new Error("streamChat did not stop after quiet content stream")), 250);
      })
    ]);

    assert.equal(events.filter((event) => event.type === "content").map((event) => event.text).join(""), "done");
    assert.equal(events[events.length - 1]?.type, "done");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGrace === undefined) {
      delete process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
    } else {
      process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = originalGrace;
    }
  }
});

test("returns tool calls after an OpenAI-compatible endpoint goes quiet", async () => {
  const originalFetch = globalThis.fetch;
  const originalGrace = process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
  process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = "25";
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"test/unit/a.test.ts\",\"content\":\"ok\"}" } }] } }] })}\n\n`));
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
        setTimeout(() => reject(new Error("streamChat did not stop after quiet tool-call stream")), 250);
      })
    ]);

    const toolCallEvent = events.find((event) => event.type === "toolCalls");
    assert.ok(toolCallEvent && toolCallEvent.type === "toolCalls");
    assert.equal(toolCallEvent.toolCalls[0]?.name, "write_file");
    assert.equal(toolCallEvent.toolCalls[0]?.argumentsJson, "{\"path\":\"test/unit/a.test.ts\",\"content\":\"ok\"}");
    assert.equal(events[events.length - 1]?.type, "done");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGrace === undefined) {
      delete process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
    } else {
      process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = originalGrace;
    }
  }
});

test("extends the quiet grace once when tool-call arguments have not finished parsing", async () => {
  const originalFetch = globalThis.fetch;
  const originalGrace = process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
  const originalExtensions = process.env.CODEFORGE_OPENAI_STREAM_QUIET_EXTENSIONS;
  process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = "25";
  process.env.CODEFORGE_OPENAI_STREAM_QUIET_EXTENSIONS = "1";
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"a.t" } }] } }] })}\n\n`));
        setTimeout(() => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "xt\",\"content\":\"ok\"}" } }] } }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`));
          controller.close();
        }, 35);
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
        setTimeout(() => reject(new Error("streamChat did not finish in time")), 500);
      })
    ]);

    const toolCallEvent = events.find((event) => event.type === "toolCalls");
    assert.ok(toolCallEvent && toolCallEvent.type === "toolCalls");
    assert.equal(toolCallEvent.toolCalls[0]?.argumentsJson, "{\"path\":\"a.txt\",\"content\":\"ok\"}");
    JSON.parse(toolCallEvent.toolCalls[0]?.argumentsJson ?? "");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGrace === undefined) {
      delete process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS;
    } else {
      process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS = originalGrace;
    }
    if (originalExtensions === undefined) {
      delete process.env.CODEFORGE_OPENAI_STREAM_QUIET_EXTENSIONS;
    } else {
      process.env.CODEFORGE_OPENAI_STREAM_QUIET_EXTENSIONS = originalExtensions;
    }
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

test("treats partial SSE chunks as model progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`));
        controller.enqueue(encoder.encode("\n\n"));
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
    const events = [];
    for await (const event of provider.streamChat({ model: "local-model", messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "progress");
    assert.equal(events.some((event) => event.type === "content"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats streamed tool-call argument chunks as model progress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "edit_file", arguments: "{\"path\":" } }] } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\",\"oldText\":\"old\",\"newText\":\"new\"}" } }] } }] })}\n\n`));
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

    assert.equal(events.filter((event) => event.type === "progress").length, 2);
    const toolCallEvent = events.find((event) => event.type === "toolCalls");
    assert.ok(toolCallEvent && toolCallEvent.type === "toolCalls");
    assert.equal(toolCallEvent.toolCalls[0]?.name, "edit_file");
    assert.equal(toolCallEvent.toolCalls[0]?.argumentsJson, "{\"path\":\"README.md\",\"oldText\":\"old\",\"newText\":\"new\"}");
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

test("deduplicates repeated assistant tool-call ids before OpenAI requests", () => {
  const repaired = ensureOpenAiToolResultPairing([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-a", name: "read_file", argumentsJson: "{\"path\":\"a.ts\"}" }]
    },
    { role: "tool", content: "read_file a.ts\n\n1", name: "read_file", toolCallId: "call-a" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-a", name: "read_file", argumentsJson: "{\"path\":\"a.ts\"}" }]
    },
    { role: "tool", content: "read_file a.ts\n\n1", name: "read_file", toolCallId: "call-a" }
  ]);

  assert.equal(repaired.length, 3);
  assert.equal(repaired[2]?.role, "assistant");
  assert.equal(repaired[2]?.toolCalls, undefined);
  assert.match(repaired[2]?.content ?? "", /Duplicate tool calls removed/);
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
        aliases: undefined,
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

test("reads LiteLLM max_tokens as the served context length, not the output limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [
          // LiteLLM advertises the configured context length under `max_tokens`.
          { id: "gemma-4-31b-it", object: "model", max_tokens: 262144, max_output_tokens: 8192 },
          // When a more specific context field is present it still wins over max_tokens.
          { id: "qwen3", object: "model", max_model_len: 40960, max_tokens: 32768 }
        ]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000" },
      { allowlist: [] }
    );
    const inspection = await provider.inspectEndpoint();
    const gemma = inspection.models.find((model) => model.id === "gemma-4-31b-it");
    const qwen = inspection.models.find((model) => model.id === "qwen3");
    assert.equal(gemma?.contextLength, 262144);
    assert.equal(gemma?.maxOutputTokens, 8192);
    assert.equal(qwen?.contextLength, 40960);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function detectContextLength(model: Record<string, unknown>): Promise<number | undefined> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [model] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:1234" },
      { allowlist: [] }
    );
    const inspection = await provider.inspectEndpoint();
    return inspection.models.find((entry) => entry.id === model.id)?.contextLength;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("reads llama.cpp runtime context from nested meta.n_ctx, preferring it over n_ctx_train", async () => {
  // Real llama-server /v1/models payload shape: context lives under `meta`, with the live per-slot
  // window (n_ctx) smaller than the model's trained maximum (n_ctx_train). The runtime window wins.
  const contextLength = await detectContextLength({
    id: "unsloth/gemma-4-12b-it-GGUF",
    aliases: ["unsloth/gemma-4-12b-it-GGUF"],
    object: "model",
    created: 1780844598,
    owned_by: "llamacpp",
    meta: { vocab_type: 2, n_vocab: 262144, n_ctx: 196608, n_ctx_train: 262144, n_embd: 3840, n_params: 11907350576, size: 7106035904 }
  });
  assert.equal(contextLength, 196608);
});

test("falls back to llama.cpp meta.n_ctx_train when the runtime n_ctx is absent (older builds)", async () => {
  const contextLength = await detectContextLength({
    id: "llama-3.1-8b",
    object: "model",
    owned_by: "llamacpp",
    meta: { vocab_type: 2, n_vocab: 128256, n_ctx_train: 131072, n_embd: 4096, n_params: 8030261248, size: 4920733696 }
  });
  assert.equal(contextLength, 131072);
});

test("prefers a higher-priority context field nested under model_info over a top-level max_tokens", async () => {
  // LiteLLM /model/info-derived shape: the real input window is nested while a small max_tokens sits
  // at the top level. Priority must dominate nesting depth, so max_input_tokens wins.
  const contextLength = await detectContextLength({
    id: "gpt-4o-proxy",
    object: "model",
    owned_by: "openai",
    max_tokens: 4096,
    model_info: { max_input_tokens: 128000, max_output_tokens: 16384, max_tokens: 16384 }
  });
  assert.equal(contextLength, 128000);
});

test("prefers loaded_context_length over max_context_length for an LM Studio loaded model", async () => {
  const contextLength = await detectContextLength({
    id: "google/gemma-4-26b",
    object: "model",
    state: "loaded",
    max_context_length: 262144,
    loaded_context_length: 200000
  });
  assert.equal(contextLength, 200000);
});

test("reads a nested TabbyAPI parameters.max_seq_len context window", async () => {
  const contextLength = await detectContextLength({
    id: "turboderp_Llama-3.1-8B-exl2",
    object: "model",
    parameters: { max_seq_len: 32768, cache_size: 32768, rope_scale: 1.0 }
  });
  assert.equal(contextLength, 32768);
});

test("does not mistake a stray integer inside an array for a context window", async () => {
  // vLLM exposes max_model_len plus a permission[] array carrying max_tokens: 1; arrays are never
  // descended into, and the small value would be rejected by the sanity floor regardless.
  const contextLength = await detectContextLength({
    id: "meta-llama/Llama-3.1-8B-Instruct",
    object: "model",
    owned_by: "vllm",
    max_model_len: 131072,
    permission: [{ id: "modelperm-abc", object: "model_permission", max_tokens: 1 }]
  });
  assert.equal(contextLength, 131072);
});

test("reports no context length when only an implausibly small value is present", async () => {
  const contextLength = await detectContextLength({
    id: "no-ctx-model",
    object: "model",
    permission: [{ id: "p1", object: "model_permission", max_tokens: 1 }]
  });
  assert.equal(contextLength, undefined);
});

test("accepts a string-typed numeric context length", async () => {
  const contextLength = await detectContextLength({ id: "string-ctx", object: "model", max_model_len: "131072" });
  assert.equal(contextLength, 131072);
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

test("sanitizeToolArgumentsJson passes valid JSON objects through unchanged", () => {
  const valid = "{\"path\":\"src/index.ts\",\"reason\":\"read it\"}";
  assert.equal(sanitizeToolArgumentsJson(valid), valid);
});

test("sanitizeToolArgumentsJson defaults empty or whitespace arguments to an object", () => {
  assert.equal(sanitizeToolArgumentsJson(undefined), "{}");
  assert.equal(sanitizeToolArgumentsJson(""), "{}");
  assert.equal(sanitizeToolArgumentsJson("   "), "{}");
});

test("sanitizeToolArgumentsJson repairs a value truncated mid-string", () => {
  // The exact failure shape: a local model cut the arguments off inside the path string.
  const repaired = sanitizeToolArgumentsJson("{\"path\":\"src/core/openaiAd");
  const parsed = JSON.parse(repaired);
  assert.equal(typeof parsed, "object");
  assert.equal((parsed as { readonly path?: string }).path, "src/core/openaiAd");
});

test("sanitizeToolArgumentsJson drops a dangling key with no value", () => {
  const repaired = sanitizeToolArgumentsJson("{\"path\":\"src\",\"reason\"");
  const parsed = JSON.parse(repaired) as { readonly path?: string; readonly reason?: unknown };
  assert.equal(parsed.path, "src");
  assert.equal("reason" in parsed, false);
});

test("sanitizeToolArgumentsJson falls back to an empty object when repair is impossible", () => {
  assert.equal(sanitizeToolArgumentsJson("not json at all"), "{}");
  assert.equal(sanitizeToolArgumentsJson("{\"path\":\"src\",\"reason\":"), "{}");
});

test("resolveRequestMaxTokens returns undefined (no limit) for preference 0", () => {
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 131072 }, undefined, 0), undefined);
  assert.equal(resolveRequestMaxTokens(undefined, undefined, 0), undefined);
});

test("resolveRequestMaxTokens defaults to ~32k, bounded by half the context window", () => {
  // Large context -> the full 32k default.
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 262144 }), 32000);
  // Small context -> bounded so the prompt always has room.
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 32768 }), 16384);
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 8192 }), 4096);
});

test("resolveRequestMaxTokens never exceeds the model's reported output limit", () => {
  assert.equal(resolveRequestMaxTokens({ id: "m", maxOutputTokens: 8192, contextLength: 262144 }), 8192);
});

test("resolveRequestMaxTokens honors an explicit cap, bounded by half the context window", () => {
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 262144 }, undefined, 16000), 16000);
  // A cap that would leave no room for the prompt is bounded to half the window.
  assert.equal(resolveRequestMaxTokens({ id: "m", contextLength: 32768 }, undefined, 30000), 16384);
  // No known context window -> the explicit value is used verbatim.
  assert.equal(resolveRequestMaxTokens(undefined, undefined, 12000), 12000);
});

test("resolveRequestMaxTokens uses the configured context limit when the model omits one", () => {
  assert.equal(resolveRequestMaxTokens(undefined, 8000, 32000), 4000);
});

test("streamChat forwards max_tokens to the endpoint when provided", async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: string | undefined;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    postedBody = String(init?.body ?? "");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    for await (const _event of provider.streamChat({
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4096
    })) {
      // Drain.
    }
    const withLimit = JSON.parse(String(postedBody ?? "{}")) as { readonly max_tokens?: number };
    assert.equal(withLimit.max_tokens, 4096);

    for await (const _event of provider.streamChat({
      model: "local-model",
      messages: [{ role: "user", content: "hi" }]
    })) {
      // Drain.
    }
    const withoutLimit = JSON.parse(String(postedBody ?? "{}")) as { readonly max_tokens?: number };
    assert.equal("max_tokens" in withoutLimit, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat never replays a malformed historical tool call to the endpoint", async () => {
  // Regression for the LiteLLM 400 "Unterminated string": a prior assistant turn recorded a
  // truncated tool-call arguments string. It must be sanitized to valid JSON on the next request
  // instead of being serialized verbatim (which made LiteLLM reject the whole request body).
  const originalFetch = globalThis.fetch;
  let postedBody: string | undefined;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    postedBody = String(init?.body ?? "");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  try {
    const provider = new OpenAiCompatibleProvider(
      { id: "test", label: "Test", baseUrl: "http://127.0.0.1:4000/v1" },
      { allowlist: [] }
    );
    for await (const _event of provider.streamChat({
      model: "local-model",
      messages: [
        { role: "user", content: "read the adapter" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", argumentsJson: "{\"path\":\"src/core/openaiAd" }]
        },
        {
          role: "tool",
          name: "read_file",
          toolCallId: "call_1",
          content: "<tool_use_error>Error: Arguments for read_file must be valid JSON.</tool_use_error>"
        }
      ]
    })) {
      // Drain the stream.
    }

    const body = JSON.parse(String(postedBody ?? "{}")) as {
      readonly messages: ReadonlyArray<{
        readonly role: string;
        readonly tool_calls?: ReadonlyArray<{ readonly function: { readonly arguments: string } }>;
      }>;
    };
    const assistant = body.messages.find((message) => message.role === "assistant" && message.tool_calls);
    assert.ok(assistant, "expected the assistant tool-call turn to be present in the request");
    const rawArguments = assistant!.tool_calls![0].function.arguments;
    assert.doesNotThrow(() => JSON.parse(rawArguments), "outgoing tool-call arguments must be valid JSON");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
