import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkspacePath,
  validateWorkspaceGlob,
  validatePatch,
  validateTaskId,
  validateLimit,
  validateSearchQuery,
  parseTaskStatus,
  parseNotebookCellKind,
  parseQuestions,
  optionalString,
  optionalStringArray,
  optionalPositiveInteger,
  isSafeMcpName,
  isSafeWorkerId,
  isSafeExtensionName
} from "../../src/core/toolValidation";

test("validateWorkspacePath accepts repo-relative paths and rejects escapes", () => {
  assert.equal(validateWorkspacePath("src/a.ts").ok, true);
  assert.equal(validateWorkspacePath("").ok, false);
  assert.equal(validateWorkspacePath("../secret").ok, false);
  assert.equal(validateWorkspacePath("~/x").ok, false);
  assert.equal(validateWorkspacePath("a\0b").ok, false);
});

test("validateWorkspaceGlob rejects absolute and parent globs", () => {
  assert.equal(validateWorkspaceGlob("src/**/*.ts").ok, true);
  assert.equal(validateWorkspaceGlob("/etc/*").ok, false);
  assert.equal(validateWorkspaceGlob("../**").ok, false);
  assert.equal(validateWorkspaceGlob("C:/x").ok, false);
  assert.equal(validateWorkspaceGlob("").ok, false);
});

test("validatePatch requires a parseable diff", () => {
  assert.equal(validatePatch("not a patch").ok, false);
});

test("task / limit / search bounds", () => {
  assert.equal(validateTaskId("task-123-abcdef").ok, true);
  assert.equal(validateTaskId("nope").ok, false);
  assert.equal(validateLimit(undefined).ok, true);
  assert.equal(validateLimit(0).ok, false);
  assert.equal(validateLimit(1001).ok, false);
  assert.equal(validateLimit(50).ok, true);
  assert.equal(validateSearchQuery("foo").ok, true);
  assert.equal(validateSearchQuery("").ok, false);
});

test("parse helpers narrow unknown input", () => {
  assert.equal(parseTaskStatus("completed"), "completed");
  assert.equal(parseTaskStatus("bogus"), undefined);
  assert.equal(parseNotebookCellKind("code"), "code");
  assert.equal(parseNotebookCellKind("bogus"), undefined);
  assert.equal(optionalString("x"), "x");
  assert.equal(optionalString(5), undefined);
  assert.equal(optionalPositiveInteger(3.9), 3);
  assert.equal(optionalPositiveInteger(0), 1);
  assert.equal(optionalPositiveInteger("x"), undefined);
  assert.deepEqual(optionalStringArray(["a", " b ", 3]), ["a", "b"]);
  assert.equal(optionalStringArray("x"), undefined);
  assert.equal(isSafeMcpName("server/tool-1"), true);
  assert.equal(isSafeMcpName("../evil"), false);
  assert.equal(isSafeWorkerId("worker-12-abcdef"), true);
  assert.equal(isSafeWorkerId("nope"), false);
  assert.equal(isSafeExtensionName("my-skill_1"), true);
  assert.equal(isSafeExtensionName("1bad"), false);
});

test("parseQuestions keeps valid questions and drops malformed entries", () => {
  const result = parseQuestions([
    {
      question: "Q1",
      header: "H",
      options: [{ label: "A", description: "a" }, { label: "B", description: "b", preview: "p" }],
      multiSelect: true
    },
    { question: "missing options" },
    "garbage"
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].question, "Q1");
  assert.equal(result[0].options.length, 2);
  assert.equal(result[0].options[1].preview, "p");
  assert.equal(result[0].multiSelect, true);
});
