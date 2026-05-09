import * as assert from "assert";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("codeforge.codeforge");
  assert.ok(extension);
  await extension.activate();
  assert.equal(extension.isActive, true);
}
