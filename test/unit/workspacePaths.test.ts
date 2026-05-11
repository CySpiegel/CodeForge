import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspacePathInput, workspacePathCandidates } from "../../src/core/workspacePaths";

test("normalizes model-provided workspace path wrappers", () => {
  assert.equal(normalizeWorkspacePathInput("`src/index.ts`"), "src/index.ts");
  assert.equal(normalizeWorkspacePathInput("<src/index.ts>"), "src/index.ts");
  assert.equal(normalizeWorkspacePathInput(" src\\index.ts "), "src/index.ts");
});

test("builds read candidates from grep-style paths", () => {
  assert.deepEqual(workspacePathCandidates("src/index.ts:12:4"), ["src/index.ts:12:4", "src/index.ts"]);
  assert.deepEqual(workspacePathCandidates("CodeForge/src/index.ts:12", ["CodeForge"]), [
    "CodeForge/src/index.ts:12",
    "src/index.ts:12",
    "CodeForge/src/index.ts",
    "src/index.ts"
  ]);
});

test("keeps absolute paths and file uris as candidates", () => {
  assert.deepEqual(workspacePathCandidates("/repo/src/index.ts:12"), ["/repo/src/index.ts:12", "/repo/src/index.ts"]);
  assert.deepEqual(workspacePathCandidates("file:///repo/src/index.ts:12"), ["file:///repo/src/index.ts:12", "file:///repo/src/index.ts"]);
});
