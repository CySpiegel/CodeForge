import test from "node:test";
import assert from "node:assert/strict";
import { formatMemories, memoryMatchesFilter, normalizeMemoryNamespace, normalizeMemoryText } from "../../src/core/memory";

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

test("filters scoped memories for local agents", () => {
  const memories = [
    { id: "memory-1", text: "Shared repo fact.", createdAt: 1, scope: "workspace" as const },
    { id: "memory-2", text: "Reviewer preference.", createdAt: 2, scope: "agent" as const, namespace: "reviewer" },
    { id: "memory-3", text: "Planner note.", createdAt: 3, scope: "agent" as const, namespace: "planner" }
  ];

  const filtered = memories.filter((memory) => memoryMatchesFilter(memory, { scope: "agent", namespace: "reviewer", includeShared: true }));

  assert.deepEqual(filtered.map((memory) => memory.id), ["memory-1", "memory-2"]);
  assert.equal(normalizeMemoryNamespace(" Reviewer "), "reviewer");
  assert.equal(normalizeMemoryNamespace("../bad"), undefined);
});
