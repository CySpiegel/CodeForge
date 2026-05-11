import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const testWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-vscode-test-"));
  fs.writeFileSync(path.join(testWorkspacePath, "README.md"), "# CodeForge test workspace\n", "utf8");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [testWorkspacePath, "--disable-extensions"]
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
