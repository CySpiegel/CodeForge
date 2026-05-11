import test from "node:test";
import assert from "node:assert/strict";
import { AgentAction } from "../../src/core/types";
import { codeForgeTools, isReadOnlyAction, parseAction, toolDefinitions, validateAction, validateWorkspacePath } from "../../src/core/toolRegistry";

test("validates repo paths", () => {
  assert.equal(validateWorkspacePath("src/core/types.ts").ok, true);
  assert.equal(validateWorkspacePath("../secret.txt").ok, false);
  assert.equal(validateWorkspacePath("/repo/src/index.ts").ok, true);
  assert.equal(validateWorkspacePath("C:\\repo\\src\\index.ts").ok, true);
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

test("every registered tool has metadata, an API definition, and a valid parse sample", () => {
  const definitionsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const expectedSamples = new Set(Object.keys(validToolSamples));

  for (const tool of codeForgeTools) {
    assert.equal(definitionsByName.has(tool.name), true, `${tool.name} should have an API definition`);
    assert.equal(tool.description.trim().length > 0, true, `${tool.name} should have a description`);
    assert.equal(tool.searchHint?.trim().length ? true : false, true, `${tool.name} should have a search hint`);
    assert.equal(tool.risk.length > 0, true, `${tool.name} should have a risk`);
    assert.equal(typeof tool.concurrencySafe, "boolean", `${tool.name} should declare concurrency`);
    assert.equal(typeof tool.requiresApproval, "boolean", `${tool.name} should declare approval behavior`);

    const sample = validToolSamples[tool.name];
    assert.ok(sample, `${tool.name} should have a valid sample`);
    const parsed = parseAction(tool.name, sample);
    assert.ok(parsed, `${tool.name} sample should parse`);
    assert.equal(validateAction(parsed).ok, true, `${tool.name} sample should validate`);
  }

  assert.deepEqual([...expectedSamples].sort(), codeForgeTools.map((tool) => tool.name).sort());
});

test("tool read-only classification matches approval metadata", () => {
  for (const tool of codeForgeTools) {
    const parsed = parseAction(tool.name, validToolSamples[tool.name]);
    assert.ok(parsed);
    if (isReadOnlyAction(parsed)) {
      assert.equal(tool.requiresApproval, tool.name === "ask_user_question", `${tool.name} read-only tools should not require approval metadata unless they need user interaction`);
    }
    if (tool.requiresApproval && tool.name !== "ask_user_question") {
      assert.equal(isReadOnlyAction(parsed), false, `${tool.name} approval tools should not be classified as read-only`);
    }
  }
});

const validPatch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

const validToolSamples: Record<AgentAction["type"], Record<string, unknown>> = {
  list_files: { pattern: "src/**/*.ts", limit: 10 },
  glob_files: { pattern: "src/**/*.ts", limit: 10 },
  read_file: { path: "src/core/types.ts" },
  search_text: { query: "AgentController" },
  grep_text: { query: "AgentController", include: "src/**/*.ts", limit: 10 },
  list_diagnostics: { path: "src/core/types.ts", limit: 10 },
  spawn_agent: { agent: "review", prompt: "Review src/core/types.ts" },
  worker_output: { workerId: "worker-1-a" },
  ask_user_question: {
    questions: [
      {
        question: "Which path should CodeForge use?",
        header: "Path",
        options: [
          { label: "Small", description: "Make a focused patch." },
          { label: "Broad", description: "Refactor the area." }
        ]
      }
    ]
  },
  tool_search: { query: "code symbols", limit: 5 },
  tool_list: {},
  task_create: { subject: "Implement auth", description: "Add middleware" },
  task_update: { taskId: "task-1-a", status: "in_progress" },
  task_list: { status: "pending" },
  task_get: { taskId: "task-1-a" },
  code_hover: { path: "src/core/types.ts", line: 1, character: 1 },
  code_definition: { path: "src/core/types.ts", line: 1, character: 1 },
  code_references: { path: "src/core/types.ts", line: 1, character: 1 },
  code_symbols: { path: "src/core/types.ts" },
  mcp_list_resources: { serverId: "local" },
  mcp_read_resource: { serverId: "local", uri: "file:///notes.md" },
  notebook_read: { path: "notebooks/demo.ipynb" },
  notebook_edit_cell: { path: "notebooks/demo.ipynb", index: 0, content: "print('hi')", language: "python", kind: "code" },
  memory_write: { text: "Prefer local endpoints.", scope: "workspace" },
  propose_patch: { patch: validPatch },
  write_file: { path: "src/new.ts", content: "export {};\n" },
  edit_file: { path: "src/core/types.ts", oldText: "old", newText: "new" },
  open_diff: { patch: validPatch },
  run_command: { command: "npm test", cwd: "." },
  mcp_call_tool: { serverId: "local", toolName: "tools.echo", arguments: { message: "hi" } }
};
