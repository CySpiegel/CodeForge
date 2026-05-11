import test from "node:test";
import assert from "node:assert/strict";
import { evaluateActionPermission, normalizePermissionPolicy, parsePermissionRules } from "../../src/core/permissions";
import { AgentAction, PermissionPolicy } from "../../src/core/types";

test("smart mode allows reads, small edits, and asks for commands", () => {
  const policy: PermissionPolicy = { mode: "smart", rules: [] };
  assert.equal(evaluateActionPermission({ type: "read_file", path: "src/index.ts" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "search_text", query: "AgentController" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "list_diagnostics", path: "src/index.ts" }, policy).behavior, "allow");
  assert.equal(
    evaluateActionPermission(
      { type: "propose_patch", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
      policy
    ).behavior,
    "allow"
  );
  assert.equal(evaluateActionPermission({ type: "write_file", path: "src/new.ts", content: "export {};" }, policy).behavior, "ask");
  assert.equal(evaluateActionPermission({ type: "run_command", command: "npm test" }, policy).behavior, "ask");
  assert.equal(evaluateActionPermission({ type: "mcp_call_tool", serverId: "local", toolName: "tools.echo" }, policy).behavior, "ask");
});

test("applies deny ask allow precedence", () => {
  const policy: PermissionPolicy = {
    mode: "smart",
    rules: [
      { kind: "command", pattern: "npm test", behavior: "allow", scope: "workspace" },
      { kind: "command", pattern: "npm *", behavior: "ask", scope: "workspace" },
      { kind: "command", pattern: "npm test", behavior: "deny", scope: "user" }
    ]
  };

  const decision = evaluateActionPermission({ type: "run_command", command: "npm test" }, policy);
  assert.equal(decision.behavior, "deny");
  assert.equal(decision.source, "rule");
  assert.equal(decision.rule?.scope, "user");
});

test("manual mode asks for side effects even with allow rules", () => {
  assert.equal(
    evaluateActionPermission(
      { type: "run_command", command: "npm test" },
      { mode: "manual", rules: [{ kind: "command", pattern: "npm test", behavior: "allow", scope: "workspace" }] }
    ).behavior,
    "ask"
  );
  assert.equal(
    evaluateActionPermission(
      { type: "propose_patch", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
      { mode: "manual", rules: [] }
    ).behavior,
    "ask"
  );
});

test("full auto mode allows edits and commands", () => {
  const policy: PermissionPolicy = { mode: "fullAuto", rules: [] };
  assert.equal(
    evaluateActionPermission(
      { type: "propose_patch", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
      policy
    ).behavior,
    "allow"
  );
  assert.equal(evaluateActionPermission({ type: "run_command", command: "npm test" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "mcp_call_tool", serverId: "local", toolName: "tools.echo" }, policy).behavior, "allow");
});

test("applies endpoint rules to MCP server ids", () => {
  const decision = evaluateActionPermission(
    { type: "mcp_call_tool", serverId: "prod-local", toolName: "tools.echo" },
    { mode: "fullAuto", rules: [{ kind: "endpoint", pattern: "prod-*", behavior: "deny", scope: "workspace" }] }
  );

  assert.equal(decision.behavior, "deny");
  assert.equal(decision.source, "rule");
});

test("parses persisted permission rules safely", () => {
  const rules = parsePermissionRules(
    [
      { kind: "path", pattern: "src/*", behavior: "deny", scope: "user" },
      { kind: "path", pattern: "", behavior: "deny" },
      { kind: "bad", pattern: "src/*", behavior: "deny" }
    ],
    "workspace"
  );
  const policy = normalizePermissionPolicy({ mode: "smart", rules });
  assert.deepEqual(policy.rules, [{ kind: "path", pattern: "src/*", behavior: "deny", scope: "user", description: undefined }]);
});

test("permission mode matrix covers each side-effect family", () => {
  const cases: Array<{
    readonly name: string;
    readonly action: AgentAction;
    readonly manual: string;
    readonly smart: string;
    readonly fullAuto: string;
  }> = [
    {
      name: "small patch",
      action: { type: "propose_patch", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      manual: "ask",
      smart: "allow",
      fullAuto: "allow"
    },
    {
      name: "large patch",
      action: { type: "propose_patch", patch: largePatch() },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "file creation",
      action: { type: "write_file", path: "src/new.ts", content: "export {};\n" },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "small exact edit",
      action: { type: "edit_file", path: "src/a.ts", oldText: "old", newText: "new" },
      manual: "ask",
      smart: "allow",
      fullAuto: "allow"
    },
    {
      name: "replace all edit",
      action: { type: "edit_file", path: "src/a.ts", oldText: "old", newText: "new", replaceAll: true },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "notebook edit",
      action: { type: "notebook_edit_cell", path: "notebooks/a.ipynb", index: 0, content: "print('hi')" },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "memory write",
      action: { type: "memory_write", text: "Prefer local models." },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "command",
      action: { type: "run_command", command: "npm test" },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    },
    {
      name: "mcp service call",
      action: { type: "mcp_call_tool", serverId: "local", toolName: "tools.echo" },
      manual: "ask",
      smart: "ask",
      fullAuto: "allow"
    }
  ];

  for (const item of cases) {
    assert.equal(evaluateActionPermission(item.action, { mode: "manual", rules: [] }).behavior, item.manual, `${item.name} manual`);
    assert.equal(evaluateActionPermission(item.action, { mode: "smart", rules: [] }).behavior, item.smart, `${item.name} smart`);
    assert.equal(evaluateActionPermission(item.action, { mode: "fullAuto", rules: [] }).behavior, item.fullAuto, `${item.name} fullAuto`);
  }
});

test("deny rules override read-only defaults and full-auto side effects", () => {
  assert.equal(
    evaluateActionPermission(
      { type: "read_file", path: "src/secret.ts" },
      { mode: "smart", rules: [{ kind: "path", pattern: "src/secret.ts", behavior: "deny", scope: "workspace" }] }
    ).behavior,
    "deny"
  );
  assert.equal(
    evaluateActionPermission(
      { type: "run_command", command: "npm publish" },
      { mode: "fullAuto", rules: [{ kind: "command", pattern: "npm publish", behavior: "deny", scope: "workspace" }] }
    ).behavior,
    "deny"
  );
});

test("smart-mode command and MCP prompts are not bypassed by allow rules", () => {
  assert.equal(
    evaluateActionPermission(
      { type: "run_command", command: "npm test -- --runInBand" },
      { mode: "smart", rules: [{ kind: "command", pattern: "npm test", behavior: "allow", scope: "workspace" }] }
    ).behavior,
    "ask"
  );
  assert.equal(
    evaluateActionPermission(
      { type: "mcp_call_tool", serverId: "local-dev", toolName: "tools.echo" },
      { mode: "smart", rules: [{ kind: "endpoint", pattern: "local-*", behavior: "allow", scope: "workspace" }] }
    ).behavior,
    "ask"
  );
});

function largePatch(): string {
  const removed = Array.from({ length: 81 }, (_, index) => `-old${index}`).join("\n");
  const added = Array.from({ length: 81 }, (_, index) => `+new${index}`).join("\n");
  return `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,81 +1,81 @@\n${removed}\n${added}\n`;
}
