import test from "node:test";
import assert from "node:assert/strict";
import { safeParseArgs } from "../../src/agent/toolText";

test("safeParseArgs parses valid object arguments", () => {
  assert.deepEqual(safeParseArgs("{\"action\":\"add\",\"content\":\"a fact\"}"), { action: "add", content: "a fact" });
});

test("safeParseArgs recovers a truncated review/curator argument instead of dropping it", () => {
  // The background review's memory/skill writes truncate mid-content on local models. safeParseArgs now
  // repairs the partial object rather than silently returning {} (which would lose the learned content).
  assert.deepEqual(
    safeParseArgs("{\"action\":\"add\",\"target\":\"user\",\"content\":\"User prefers terse"),
    { action: "add", target: "user", content: "User prefers terse" }
  );
});

test("safeParseArgs falls back to an empty object for unrecoverable input", () => {
  assert.deepEqual(safeParseArgs("not json at all"), {});
  assert.deepEqual(safeParseArgs(""), {});
});
