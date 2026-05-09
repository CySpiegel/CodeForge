import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";

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
