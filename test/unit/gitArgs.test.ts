import test from "node:test";
import assert from "node:assert/strict";
import { buildGitArgv } from "../../src/agent/agentController";

test("buildGitArgv builds safe argv for read-only operations", () => {
  assert.deepEqual(buildGitArgv({ type: "git", operation: "status" }), ["status", "--short", "--branch"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "diff", args: "--cached" }), ["diff", "--cached"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "diff", args: "--stat src/a.ts" }), ["diff", "--stat", "src/a.ts"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "log", args: "-n 5" }), ["log", "--oneline", "--decorate", "-n", "5"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "log" }), ["log", "--oneline", "--decorate", "-n", "30"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "show", args: "HEAD~2" }), ["show", "--stat", "HEAD~2"]);
  assert.deepEqual(buildGitArgv({ type: "git", operation: "branch" }), ["branch", "--all", "--verbose"]);
});

test("buildGitArgv rejects unsafe arguments", () => {
  assert.equal(buildGitArgv({ type: "git", operation: "diff", args: "--output=/etc/passwd" }), undefined);
  assert.equal(buildGitArgv({ type: "git", operation: "diff", args: "--upload-pack=evil" }), undefined);
  assert.equal(buildGitArgv({ type: "git", operation: "log", args: "; rm -rf /" }), undefined);
  assert.equal(buildGitArgv({ type: "git", operation: "show", args: "$(whoami)" }), undefined);
  assert.equal(buildGitArgv({ type: "git", operation: "diff", args: "-c core.pager=touch" }), undefined);
});
