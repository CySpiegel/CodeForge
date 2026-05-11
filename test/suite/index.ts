import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

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
