import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfiguredModelId } from "../../src/agent/agentController";
import { ModelInfo } from "../../src/core/types";

const models: readonly ModelInfo[] = [
  { id: "unsloth/gemma-4-12b-it-GGUF", aliases: ["gemma", "gemma-4"] },
  { id: "qwen3" }
];

test("exact match returns the configured id unchanged (no fallback)", () => {
  const result = resolveConfiguredModelId("qwen3", models);
  assert.equal(result.id, "qwen3");
  assert.equal(result.unmatched, false);
});

test("case/whitespace-insensitive match resolves to the canonical returned id", () => {
  const result = resolveConfiguredModelId("  UNSLOTH/Gemma-4-12B-it-GGUF  ", models);
  assert.equal(result.id, "unsloth/gemma-4-12b-it-GGUF");
  assert.equal(result.unmatched, false);
});

test("alias match resolves to the canonical returned id, not the alias", () => {
  const result = resolveConfiguredModelId("GEMMA", models);
  assert.equal(result.id, "unsloth/gemma-4-12b-it-GGUF");
  assert.equal(result.unmatched, false);
});

test("empty configured id falls back to models[0] (preserves prior behavior)", () => {
  const result = resolveConfiguredModelId("", models);
  assert.equal(result.id, "unsloth/gemma-4-12b-it-GGUF");
  assert.equal(result.unmatched, false);
});

test("whitespace-only configured id is treated as empty and falls back to models[0]", () => {
  const result = resolveConfiguredModelId("   ", models);
  assert.equal(result.id, "unsloth/gemma-4-12b-it-GGUF");
  assert.equal(result.unmatched, false);
});

test("non-empty unmatched configured id is kept (NOT swapped to models[0]) and flagged unmatched", () => {
  const result = resolveConfiguredModelId("gemma4-31b-it", models);
  assert.equal(result.id, "gemma4-31b-it");
  assert.equal(result.unmatched, true);
});

test("empty configured id with an empty model list returns empty, not unmatched", () => {
  const result = resolveConfiguredModelId("", []);
  assert.equal(result.id, "");
  assert.equal(result.unmatched, false);
});

test("non-empty configured id with an empty model list is kept and not flagged (nothing to match against)", () => {
  // Pre-inspection / error window: no models known yet, so honor the configured id verbatim and do
  // not warn (we only warn when a real, non-empty model list fails to contain the configured id).
  const result = resolveConfiguredModelId("qwen3", []);
  assert.equal(result.id, "qwen3");
  assert.equal(result.unmatched, false);
});
