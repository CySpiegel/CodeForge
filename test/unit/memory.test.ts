import test from "node:test";
import assert from "node:assert/strict";
import { formatMemories, normalizeMemoryText } from "../../src/core/memory";

test("normalizes explicit local memory text", () => {
  assert.equal(normalizeMemoryText("  Prefer focused tests.  "), "Prefer focused tests.");
  assert.equal(normalizeMemoryText(""), "");
});

test("formats memories for context", () => {
  const formatted = formatMemories([
    { id: "memory-1", text: "Use local endpoints only.", createdAt: 1 },
    { id: "memory-2", text: "Keep tests focused.", createdAt: 2 }
  ]);

  assert.match(formatted, /Use local endpoints only/);
  assert.match(formatted, /Keep tests focused/);
});
