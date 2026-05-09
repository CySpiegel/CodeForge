import test from "node:test";
import assert from "node:assert/strict";
import { buildContextUsage } from "../../src/core/contextUsage";

test("builds bounded context usage percentages", () => {
  const usage = buildContextUsage([{ role: "user", content: "x".repeat(50) }], 100);
  assert.equal(usage.maxBytes, 100);
  assert.ok(usage.usedBytes > 50);
  assert.ok(usage.percent > 0);
  assert.ok(usage.percent <= 100);
});

test("caps displayed context usage at 100 percent", () => {
  const usage = buildContextUsage([{ role: "user", content: "x".repeat(1000) }], 10);
  assert.equal(usage.percent, 100);
});

test("builds itemized context usage", () => {
  const usage = buildContextUsage(
    [
      { role: "system", content: "tool instructions" },
      { role: "user", content: "prompt" },
      { role: "assistant", content: "answer" },
      { role: "tool", content: "tool output" }
    ],
    10000,
    [
      { kind: "projectInstructions", label: "CODEFORGE.md", content: "local rules" },
      { kind: "memory", label: "CodeForge local memories", content: "- prefer tests" },
      { kind: "activeFile", label: "src/active.ts", content: "export const active = true;" },
      { kind: "openFile", label: "src/index.ts", content: "export {};" }
    ]
  );

  assert.ok(usage.breakdown.find((part) => part.key === "projectInstructions"));
  assert.ok(usage.breakdown.find((part) => part.key === "memory"));
  assert.ok(usage.breakdown.find((part) => part.key === "activeFile"));
  assert.ok(usage.breakdown.find((part) => part.key === "openFiles"));
  assert.ok(usage.breakdown.find((part) => part.key === "toolResults"));
});

test("uses provider token usage when available", () => {
  const usage = buildContextUsage(
    [{ role: "user", content: "hello" }],
    10000,
    [],
    {
      actualTokenUsage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
      maxTokens: 100
    }
  );

  assert.equal(usage.tokens.source, "actual");
  assert.equal(usage.tokens.usedTokens, 60);
  assert.equal(usage.tokens.promptTokens, 40);
  assert.equal(usage.tokens.completionTokens, 20);
  assert.equal(usage.percent, 60);
  assert.equal(usage.label, "60 / 100 tokens");
});
