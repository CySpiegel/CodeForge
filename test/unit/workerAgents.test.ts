import test from "node:test";
import assert from "node:assert/strict";
import { findWorkerDefinition, isWorkerKind, workerDefinitions } from "../../src/core/workerAgents";

const readOnlyTools = new Set(["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics"]);
const codeIntelTools = new Set(["code_hover", "code_definition", "code_references", "code_symbols"]);
const notebookReadTools = new Set(["notebook_read"]);
const baseReadTools = new Set([...readOnlyTools, ...codeIntelTools, ...notebookReadTools, "tool_search", "tool_list"]);
const planTools = new Set([...baseReadTools, "task_list", "task_get"]);
const editWorkerTools = new Set([...baseReadTools, "open_diff", "propose_patch", "write_file", "edit_file", "notebook_edit_cell", "task_create", "task_update", "task_list", "task_get", "ask_user_question"]);
const verifyWorkerTools = new Set([...baseReadTools, "run_command", "task_list", "task_get", "task_update"]);

test("defines focused built-in workers", () => {
  assert.deepEqual(workerDefinitions.map((worker) => worker.kind).sort(), ["explore", "implement", "plan", "review", "verify"]);

  for (const worker of workerDefinitions) {
    assert.ok(worker.maxTurns > 0);
    assert.ok(worker.allowedToolNames.length > 0);
    const expectedTools = worker.kind === "implement" ? editWorkerTools : worker.kind === "verify" ? verifyWorkerTools : worker.kind === "plan" ? planTools : baseReadTools;
    if (worker.kind !== "implement" && worker.kind !== "verify") {
      assert.ok(worker.systemPrompt.includes("strictly read-only"));
    }
    for (const toolName of worker.allowedToolNames) {
      assert.equal(expectedTools.has(toolName), true, `${worker.kind} should not allow ${toolName}`);
    }
  }
});

test("finds and validates worker kinds", () => {
  assert.equal(isWorkerKind("explore"), true);
  assert.equal(isWorkerKind("implement"), true);
  assert.equal(findWorkerDefinition("review")?.label, "Review");
});
