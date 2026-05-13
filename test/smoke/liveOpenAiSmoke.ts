import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { ProviderProfile } from "../../src/core/types";

const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://127.0.0.1:1234";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "google/gemma-4-31b";

async function main(): Promise<void> {
  const profile: ProviderProfile = {
    id: "smoke-profile",
    label: "Smoke",
    baseUrl,
    defaultModel: model
  };

  const provider = new OpenAiCompatibleProvider(
    profile,
    { allowlist: [] },
    { streamCompletionGraceMs: 30_000, streamQuietExtensions: 1 }
  );

  console.log(`[smoke] discovering models at ${baseUrl}/v1/models`);
  const inspection = await provider.inspectEndpoint();
  console.log(`[smoke] backend=${inspection.backendLabel} models=${inspection.models.length}`);
  if (!inspection.models.some((entry) => entry.id === model)) {
    console.warn(`[smoke] WARNING: requested model ${model} not in returned list`);
  }

  console.log(`[smoke] streaming a 1-sentence response from ${model}`);
  const start = Date.now();
  let saw = { content: 0, progress: 0, toolCalls: 0, usage: 0, done: false };
  let text = "";
  for await (const event of provider.streamChat({
    model,
    messages: [
      { role: "user", content: "Reply with exactly: smoke ok" }
    ],
    temperature: 0
  })) {
    if (event.type === "content") {
      saw.content++;
      text += event.text;
    } else if (event.type === "progress") {
      saw.progress++;
    } else if (event.type === "toolCalls") {
      saw.toolCalls++;
    } else if (event.type === "usage") {
      saw.usage++;
    } else if (event.type === "done") {
      saw.done = true;
    }
  }
  const ms = Date.now() - start;
  console.log(`[smoke] events: content=${saw.content} progress=${saw.progress} toolCalls=${saw.toolCalls} usage=${saw.usage} done=${saw.done}`);
  console.log(`[smoke] elapsed=${ms}ms text=${JSON.stringify(text.trim().slice(0, 200))}`);

  if (!saw.done) {
    throw new Error("stream did not yield a final done event");
  }
  if (saw.content === 0) {
    throw new Error("stream produced no content");
  }
  console.log("[smoke] PASS");
}

main().catch((error) => {
  console.error("[smoke] FAIL", error);
  process.exit(1);
});
