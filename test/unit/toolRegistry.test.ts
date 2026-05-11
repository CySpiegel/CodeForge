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

  const agent = parseAction("spawn_agent", { agent: "review", prompt: "review src/core/types.ts", background: false });
  assert.deepEqual(agent, { type: "spawn_agent", agent: "review", prompt: "review src/core/types.ts", description: undefined, background: false, reason: undefined });
  assert.equal(agent ? validateAction(agent).ok : false, true);

  const toolSearch = parseAction("tool_search", { query: "notebook edit", limit: 5, reason: "load deferred schema" });
  assert.deepEqual(toolSearch, { type: "tool_search", query: "notebook edit", limit: 5, reason: "load deferred schema" });
  assert.equal(toolSearch ? validateAction(toolSearch).ok : false, true);

  const memory = parseAction("memory_write", { text: "Prefer local endpoints.", scope: "workspace" });
  assert.deepEqual(memory, { type: "memory_write", text: "Prefer local endpoints.", scope: "workspace", agent: undefined, reason: undefined });
  assert.equal(memory ? validateAction(memory).ok : false, true);

  const question = parseAction("ask_user_question", {
    questions: [
      {
        question: "Which implementation path should CodeForge use?",
        header: "Approach",
        options: [
          { label: "Small patch", description: "Make the narrowest change." },
          { label: "Refactor", description: "Restructure first." }
        ]
      }
    ]
  });
  assert.equal(question ? validateAction(question).ok : false, true);

  const task = parseAction("task_create", { subject: "Implement auth", description: "Add middleware" });
  assert.equal(task ? validateAction(task).ok : false, true);

  const hover = parseAction("code_hover", { path: "src/core/types.ts", line: 10, character: 5 });
  assert.equal(hover ? validateAction(hover).ok : false, true);

  const mcpResource = parseAction("mcp_read_resource", { serverId: "local", uri: "file://context" });
  assert.equal(mcpResource ? validateAction(mcpResource).ok : false, true);

  const notebookRead = parseAction("notebook_read", { path: "notebooks/demo.ipynb" });
  assert.equal(notebookRead ? validateAction(notebookRead).ok : false, true);

  const notebookEdit = parseAction("notebook_edit_cell", { path: "notebooks/demo.ipynb", index: 0, content: "print('hi')", language: "python", kind: "code" });
  assert.equal(notebookEdit ? validateAction(notebookEdit).ok : false, true);

  const mcp = parseAction("mcp_call_tool", { serverId: "local", toolName: "tools.echo", arguments: { message: "hi" }, reason: "service lookup" });
  assert.deepEqual(mcp, { type: "mcp_call_tool", serverId: "local", toolName: "tools.echo", arguments: { message: "hi" }, reason: "service lookup" });
  assert.equal(mcp ? validateAction(mcp).ok : false, true);
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

test("rejects unsafe MCP tool identifiers", () => {
  const action = parseAction("mcp_call_tool", { serverId: "../bad", toolName: "tools.echo" });
  assert.ok(action);
  assert.equal(validateAction(action).ok, false);
});

test("rejects invalid structured user questions", () => {
  const action = parseAction("ask_user_question", {
    questions: [
      {
        question: "Missing question mark",
        header: "Too long header text",
        options: [{ label: "Only", description: "one option" }]
      }
    ]
  });
  assert.ok(action);
  assert.equal(validateAction(action).ok, false);
});

test("rejects invalid tool search queries", () => {
  const action = parseAction("tool_search", { query: "" });
  assert.ok(action);
  assert.equal(validateAction(action).ok, false);
});
