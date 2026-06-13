import test from "node:test";
import assert from "node:assert/strict";
import { AgentAction } from "../../src/core/types";
import {
  isReadOnlyAction,
  isLocalReadOnlyAction,
  isInternalAutomationAction,
  isInternalStateAction,
  isInternalReadAction
} from "../../src/core/toolClassification";

function action(type: AgentAction["type"], extra: Record<string, unknown> = {}): AgentAction {
  return { type, ...extra } as unknown as AgentAction;
}

test("isLocalReadOnlyAction covers only the local read tools", () => {
  assert.equal(isLocalReadOnlyAction(action("read_file", { path: "x" })), true);
  assert.equal(isLocalReadOnlyAction(action("list_files")), true);
  assert.equal(isLocalReadOnlyAction(action("grep_text", { query: "x" })), true);
  assert.equal(isLocalReadOnlyAction(action("write_file")), false);
  assert.equal(isLocalReadOnlyAction(action("mcp_read_resource")), false);
});

test("isReadOnlyAction is broader than local reads but excludes mutations", () => {
  assert.equal(isReadOnlyAction(action("read_file", { path: "x" })), true);
  assert.equal(isReadOnlyAction(action("open_diff")), true);
  assert.equal(isReadOnlyAction(action("git")), true);
  assert.equal(isReadOnlyAction(action("spawn_agent")), true);
  assert.equal(isReadOnlyAction(action("write_file")), false);
  assert.equal(isReadOnlyAction(action("run_command")), false);
});

test("internal classification predicates", () => {
  assert.equal(isInternalAutomationAction(action("spawn_agent")), true);
  assert.equal(isInternalAutomationAction(action("worker_output")), true);
  assert.equal(isInternalAutomationAction(action("read_file")), false);

  assert.equal(isInternalStateAction(action("task_create")), true);
  assert.equal(isInternalStateAction(action("task_update")), true);
  assert.equal(isInternalStateAction(action("task_list")), false);

  assert.equal(isInternalReadAction(action("tool_list")), true);
  assert.equal(isInternalReadAction(action("fact_store")), true);
  assert.equal(isInternalReadAction(action("write_file")), false);
});
