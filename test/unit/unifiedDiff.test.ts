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
