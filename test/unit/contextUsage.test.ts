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
