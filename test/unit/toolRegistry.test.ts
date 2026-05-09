import test from "node:test";
import assert from "node:assert/strict";
import { parseAction, validateAction, validateWorkspacePath } from "../../src/core/toolRegistry";

test("validates workspace-relative paths", () => {
  assert.equal(validateWorkspacePath("src/core/types.ts").ok, true);
  assert.equal(validateWorkspacePath("../secret.txt").ok, false);
  assert.equal(validateWorkspacePath("/etc/passwd").ok, false);
  assert.equal(validateWorkspacePath("C:\\Windows\\System32").ok, false);
});

test("parses and validates registered tools", () => {
  const glob = parseAction("glob_files", { pattern: "src/**/*.ts", limit: 50 });
  assert.deepEqual(glob, { type: "glob_files", pattern: "src/**/*.ts", limit: 50, reason: undefined });
  assert.equal(glob ? validateAction(glob).ok : false, true);

  const readFile = parseAction("read_file", { path: "src/core/types.ts", reason: "inspect" });
  assert.deepEqual(readFile, { type: "read_file", path: "src/core/types.ts", reason: "inspect" });
  assert.equal(readFile ? validateAction(readFile).ok : false, true);

  const edit = parseAction("edit_file", { path: "src/core/types.ts", oldText: "old", newText: "new" });
  assert.deepEqual(edit, { type: "edit_file", path: "src/core/types.ts", oldText: "old", newText: "new", replaceAll: undefined, reason: undefined });
  assert.equal(edit ? validateAction(edit).ok : false, true);

  const command = parseAction("run_command", { command: "npm test", cwd: "." });
  assert.deepEqual(command, { type: "run_command", command: "npm test", cwd: ".", reason: undefined });
  assert.equal(command ? validateAction(command).ok : false, true);

  const diagnostics = parseAction("list_diagnostics", { path: "src/core/types.ts", limit: 25 });
  assert.deepEqual(diagnostics, { type: "list_diagnostics", path: "src/core/types.ts", limit: 25, reason: undefined });
  assert.equal(diagnostics ? validateAction(diagnostics).ok : false, true);
});

test("rejects malformed patch actions", () => {
  const action = parseAction("propose_patch", { patch: "not a diff" });
  assert.ok(action);
  assert.equal(validateAction(action).ok, false);
});

test("rejects unsafe glob and edit inputs", () => {
  const glob = parseAction("glob_files", { pattern: "../**/*.ts" });
  assert.ok(glob);
  assert.equal(validateAction(glob).ok, false);

  const edit = parseAction("edit_file", { path: "src/file.ts", oldText: "same", newText: "same" });
  assert.ok(edit);
  assert.equal(validateAction(edit).ok, false);
});

test("rejects untracked background command execution", () => {
  const command = parseAction("run_command", { command: "npm test &" });
  assert.ok(command);
  const result = validateAction(command);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Background shell execution/);
});
