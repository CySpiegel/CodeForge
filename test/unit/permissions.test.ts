import test from "node:test";
import assert from "node:assert/strict";
import { evaluateActionPermission, normalizePermissionPolicy, parsePermissionRules } from "../../src/core/permissions";
import { PermissionPolicy } from "../../src/core/types";

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
