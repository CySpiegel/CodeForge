import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffPreviewProvider, DiffService } from "../../src/adapters/diffService";
import { CodeForgeConfigService } from "../../src/adapters/vscodeConfig";

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
  await assertCodeForgeConfigWritesRepoSettings();
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

async function assertCodeForgeConfigWritesRepoSettings(): Promise<void> {
  const config = new CodeForgeConfigService(fakeSecretStorage());
  const model = `codeforge-suite-model-${Date.now()}`;
  try {
    await config.setModel(model);
    await config.setAgentMode("ask");
    await config.updateSettings({ permissionMode: "fullAuto", maxTokens: 131072 });

    assert.equal(config.getConfiguredModel(), model);
    assert.equal(config.getAgentMode(), "ask");
    assert.equal(config.getPermissionPolicy().mode, "fullAuto");
    assert.equal(config.getContextLimits().maxTokens, 131072);
  } finally {
    await resetConfigValue("model");
    await resetConfigValue("agent.mode");
    await resetConfigValue("permissions.mode");
    await resetConfigValue("context.maxTokens");
  }
}

function fakeSecretStorage(): vscode.SecretStorage {
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    keys: async () => [],
    onDidChange: emitter.event
  } as vscode.SecretStorage;
}

async function resetConfigValue(key: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  await Promise.allSettled([
    vscode.workspace.getConfiguration("codeforge", folder).update(key, undefined, vscode.ConfigurationTarget.Workspace),
    vscode.workspace.getConfiguration("codeforge").update(key, undefined, vscode.ConfigurationTarget.Global)
  ]);
}
