import test from "node:test";
import assert from "node:assert/strict";
import { applyFilePatch, parseUnifiedDiff, targetPath } from "../../src/core/unifiedDiff";

test("parses and applies a simple unified diff", () => {
  const diff = `--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 export function value() {
-  return 1;
+  return 2;
 }
`;

  const patches = parseUnifiedDiff(diff);
  assert.equal(patches.length, 1);
  assert.equal(targetPath(patches[0]), "src/example.ts");
  assert.equal(applyFilePatch("export function value() {\n  return 1;\n}\n", patches[0]), "export function value() {\n  return 2;\n}\n");
});

test("throws when patch context does not match", () => {
  const diff = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.throws(() => applyFilePatch("different\n", patch), /Patch does not apply/);
});

test("applies a hunk whose @@ line numbers are wrong by searching for the context", () => {
  // Local models routinely guess line numbers. The context is actually at line 2, not 50.
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -50,3 +50,3 @@
 a
-b
+B
 c
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.equal(applyFilePatch("x\na\nb\nc\n", patch), "x\na\nB\nc\n");
});

test("tolerates trailing-whitespace differences and preserves the file's actual whitespace", () => {
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
 ctx
-old
+new
`;
  const [patch] = parseUnifiedDiff(diff);
  // Source's "ctx " (trailing space) differs from the patch context "ctx"; it still matches, and the
  // emitted context line keeps the source's trailing space rather than rewriting it.
  assert.equal(applyFilePatch("ctx \nold\n", patch), "ctx \nnew\n");
});

test("tolerates leading-whitespace/indentation differences", () => {
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 if (x) {
-  return 1;
+  return 2;
 }
`;
  const [patch] = parseUnifiedDiff(diff);
  // Source is tab-indented; the patch uses spaces. It still applies (whitespace-insensitive match).
  assert.equal(applyFilePatch("\tif (x) {\n\t  return 1;\n\t}\n", patch), "\tif (x) {\n  return 2;\n\t}\n");
});

test("preserves CRLF line endings", () => {
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.equal(applyFilePatch("a\r\nb\r\nc\r\n", patch), "a\r\nB\r\nc\r\n");
});

test("parses a context line that lost its leading space", () => {
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
keep
-old
+new
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.equal(applyFilePatch("keep\nold\n", patch), "keep\nnew\n");
});

test("tolerates a missing +++ header by reusing the old path", () => {
  const diff = `--- a/f.ts
@@ -1 +1 @@
-old
+new
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.equal(targetPath(patch), "f.ts");
  assert.equal(applyFilePatch("old\n", patch), "new\n");
});

test("an unapplicable patch reports actionable, model-recoverable guidance", () => {
  const diff = `--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-old
+new
`;
  const [patch] = parseUnifiedDiff(diff);
  assert.throws(
    () => applyFilePatch("totally different content\n", patch),
    (error: Error) => /Patch does not apply/.test(error.message) && /Re-read the file/.test(error.message)
  );
});
