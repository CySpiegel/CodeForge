import test from "node:test";
import assert from "node:assert/strict";
import { findWorkerDefinition, isWorkerKind, workerDefinitions } from "../../src/core/workerAgents";

const readOnlyTools = new Set(["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics"]);

test("defines focused read-only workers", () => {
  assert.deepEqual(workerDefinitions.map((worker) => worker.kind).sort(), ["explore", "plan", "review", "verify"]);

  for (const worker of workerDefinitions) {
    assert.ok(worker.systemPrompt.includes("strictly read-only"));
    assert.ok(worker.maxTurns > 0);
    assert.ok(worker.allowedToolNames.length > 0);
    for (const toolName of worker.allowedToolNames) {
      assert.equal(readOnlyTools.has(toolName), true, `${worker.kind} should not allow ${toolName}`);
    }
  }
});

test("finds and validates worker kinds", () => {
  assert.equal(isWorkerKind("explore"), true);
  assert.equal(isWorkerKind("implement"), false);
  assert.equal(findWorkerDefinition("review")?.label, "Review");
});
