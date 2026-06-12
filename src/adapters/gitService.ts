import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { GitCommandResult, GitPort } from "../core/git";

const gitMaxBuffer = 8 * 1024 * 1024;
const gitTimeoutMs = 20_000;

// Runs read-only git subcommands in the open workspace folder. Uses execFile with an argv array (never
// a shell), so the model-supplied arguments the controller forwards cannot inject shell commands. The
// controller is still responsible for restricting which subcommands/flags are allowed.
export class GitService implements GitPort {
  async run(args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      return { ok: false, exitCode: -1, stdout: "", stderr: "No workspace folder is open." };
    }
    return new Promise<GitCommandResult>((resolve) => {
      execFile(
        "git",
        [...args],
        { cwd, maxBuffer: gitMaxBuffer, timeout: gitTimeoutMs, signal, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== "number") {
            // Spawn failure (git missing, timeout, abort) rather than a non-zero exit.
            resolve({ ok: false, exitCode: -1, stdout: stdout ?? "", stderr: stderr || error.message });
            return;
          }
          const exitCode = error ? Number((error as { code?: number }).code ?? 1) : 0;
          resolve({ ok: exitCode === 0, exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      );
    });
  }
}
