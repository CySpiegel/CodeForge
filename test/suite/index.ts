import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffPreviewProvider, DiffService } from "../../src/adapters/diffService";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("codeforge.codeforge");
  assert.ok(extension);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const packageJson = readPackageJson();
  const registeredCommands = new Set(await vscode.commands.getCommands(true));
  for (const command of packageJson.contributes.commands) {
    assert.ok(registeredCommands.has(command.command), `Expected command to be registered: ${command.command}`);
  }

  const config = vscode.workspace.getConfiguration("codeforge");
  assert.equal(config.get("agent.mode"), "agent");
  assert.equal(config.get("permissions.mode"), "smart");
  assert.equal(config.get("activeProfile"), "openai-api-local");

  await vscode.commands.executeCommand("codeforge.resetSession");
  await vscode.commands.executeCommand("codeforge.cancel");

  await assertVsCodeEditPipelineAppliesChanges();
}

interface PackageJson {
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
  };
}

function readPackageJson(): PackageJson {
  const root = path.resolve(__dirname, "../../..");
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

async function assertVsCodeEditPipelineAppliesChanges(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, "Expected a VS Code workspace folder for edit pipeline tests.");

  const previewProvider = new DiffPreviewProvider();
  const diff = new DiffService(previewProvider);

  const editTarget = vscode.Uri.joinPath(folder, "edit-target.txt");
  await vscode.workspace.fs.writeFile(editTarget, Buffer.from("alpha\nold value\nomega\n", "utf8"));
  await diff.applyEditFile({ type: "edit_file", path: "edit-target.txt", oldText: "old value", newText: "new value" });
  assert.equal(await readWorkspaceText("edit-target.txt"), "alpha\nnew value\nomega\n");

  await diff.applyWriteFile({ type: "write_file", path: "write-target.txt", content: "created by CodeForge\n" });
  assert.equal(await readWorkspaceText("write-target.txt"), "created by CodeForge\n");

  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, "patch-target.txt"), Buffer.from("export const value = 1;\n", "utf8"));
  await diff.applyPatch(`--- a/patch-target.txt
+++ b/patch-target.txt
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`);
  assert.equal(await readWorkspaceText("patch-target.txt"), "export const value = 2;\n");
}

async function readWorkspaceText(relativePath: string): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, "Expected a VS Code workspace folder.");
  return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, relativePath))).toString("utf8");
}
