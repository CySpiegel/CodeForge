import test from "node:test";
import assert from "node:assert/strict";
import { evaluateActionPermission, normalizePermissionPolicy, parsePermissionRules } from "../../src/core/permissions";
import { PermissionPolicy } from "../../src/core/types";

test("allows reads and asks for side effects in default mode", () => {
  const policy: PermissionPolicy = { mode: "default", rules: [] };
  assert.equal(evaluateActionPermission({ type: "read_file", path: "src/index.ts" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "search_text", query: "AgentController" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "list_diagnostics", path: "src/index.ts" }, policy).behavior, "allow");
  assert.equal(evaluateActionPermission({ type: "run_command", command: "npm test" }, policy).behavior, "ask");
});

test("applies deny ask allow precedence", () => {
  const policy: PermissionPolicy = {
    mode: "default",
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

test("review and read-only modes constrain side effects", () => {
  assert.equal(
    evaluateActionPermission(
      { type: "run_command", command: "npm test" },
      { mode: "review", rules: [{ kind: "command", pattern: "npm test", behavior: "allow", scope: "workspace" }] }
    ).behavior,
    "ask"
  );

  assert.equal(
    evaluateActionPermission(
      { type: "propose_patch", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
      { mode: "readOnly", rules: [] }
    ).behavior,
    "deny"
  );
});

test("acceptEdits mode allows validated patches but still asks for commands", () => {
  const policy: PermissionPolicy = { mode: "acceptEdits", rules: [] };
  assert.equal(
    evaluateActionPermission(
      { type: "propose_patch", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
      policy
    ).behavior,
    "allow"
  );
  assert.equal(evaluateActionPermission({ type: "run_command", command: "npm test" }, policy).behavior, "ask");
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
  const policy = normalizePermissionPolicy({ mode: "default", rules });
  assert.deepEqual(policy.rules, [{ kind: "path", pattern: "src/*", behavior: "deny", scope: "user", description: undefined }]);
});
