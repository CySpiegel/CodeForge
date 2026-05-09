import { spawn } from "child_process";
import * as vscode from "vscode";
import { CommandResult, RunCommandAction } from "../core/types";
import { resolveWorkspaceUri } from "./vscodeWorkspace";

export class TerminalRunner {
  async run(action: RunCommandAction, timeoutSeconds: number, onChunk: (stream: "stdout" | "stderr", text: string) => void): Promise<CommandResult> {
    const cwd = this.resolveCwd(action.cwd);
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(action.command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutSeconds * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = appendBounded(stdout, text);
        onChunk("stdout", text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = appendBounded(stderr, text);
        onChunk("stderr", text);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: appendBounded(stderr, error.message), timedOut });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      });
    });
  }

  private resolveCwd(cwd: string | undefined): string {
    if (!cwd || cwd === ".") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        throw new Error("CodeForge requires an open workspace folder to run commands.");
      }
      return folder.uri.fsPath;
    }

    return resolveWorkspaceUri(cwd).fsPath;
  }
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= 200000) {
    return combined;
  }
  return combined.slice(combined.length - 200000);
}
