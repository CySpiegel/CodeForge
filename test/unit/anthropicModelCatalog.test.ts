import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_MODEL_FALLBACK,
  parseAnthropicModels,
  resolveAnthropicMaxTokens,
  withAnthropicFallback
} from "../../src/core/anthropicModelCatalog";

test("parseAnthropicModels maps max_input_tokens -> contextLength and max_tokens -> maxOutputTokens", () => {
  const models = parseAnthropicModels({
    data: [
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", max_input_tokens: 1000000, max_tokens: 128000 },
      { id: "claude-haiku-4-5", max_input_tokens: 200000, max_tokens: 64000 }
    ]
  });
  assert.deepEqual(models, [
    { id: "claude-opus-4-8", contextLength: 1000000, maxOutputTokens: 128000, supportsReasoning: true },
    { id: "claude-haiku-4-5", contextLength: 200000, maxOutputTokens: 64000, supportsReasoning: true }
  ]);
});

test("parseAnthropicModels leaves token fields undefined when the endpoint omits them", () => {
  const models = parseAnthropicModels({ data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }] });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4-8");
  assert.equal(models[0].contextLength, undefined);
  assert.equal(models[0].maxOutputTokens, undefined);
});

test("parseAnthropicModels ignores malformed entries and non-object bodies", () => {
  assert.deepEqual(parseAnthropicModels({ data: [{ noId: true }, "x", 7] }), []);
  assert.deepEqual(parseAnthropicModels({}), []);
  assert.deepEqual(parseAnthropicModels(null), []);
});

test("withAnthropicFallback fills missing sizes from the table and falls back to the full catalogue when empty", () => {
  const filled = withAnthropicFallback([{ id: "claude-opus-4-8" }]);
  assert.equal(filled[0].contextLength, 1000000);
  assert.equal(filled[0].maxOutputTokens, 128000);

  const empty = withAnthropicFallback([]);
  assert.deepEqual(empty, ANTHROPIC_MODEL_FALLBACK);

  // A discovered value is preserved; only missing fields are filled.
  const preserved = withAnthropicFallback([{ id: "claude-opus-4-8", contextLength: 555 }]);
  assert.equal(preserved[0].contextLength, 555);
  assert.equal(preserved[0].maxOutputTokens, 128000);
});

test("resolveAnthropicMaxTokens always returns a positive integer and clamps to the model output cap", () => {
  const opus = { id: "claude-opus-4-8", maxOutputTokens: 128000 };
  // undefined preference -> default
  assert.equal(resolveAnthropicMaxTokens(opus, undefined), 32000);
  // honored when under the cap
  assert.equal(resolveAnthropicMaxTokens(opus, 8000), 8000);
  // clamped to the model cap
  assert.equal(resolveAnthropicMaxTokens({ id: "claude-haiku-4-5", maxOutputTokens: 64000 }, 200000), 64000);
  // unknown model -> requested or default, never undefined
  assert.equal(resolveAnthropicMaxTokens(undefined, 5000), 5000);
  assert.equal(resolveAnthropicMaxTokens(undefined, 0), 32000);
});
