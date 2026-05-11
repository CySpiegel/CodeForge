import { spawn } from "child_process";
import * as vscode from "vscode";
import { CommandResult, RunCommandAction } from "../core/types";
import { resolveWorkspaceUri } from "./vscodeWorkspace";

export interface CommandExecutionOptions {
  readonly timeoutSeconds: number;
  readonly outputLimitBytes: number;
  readonly signal?: AbortSignal;
}

export class TerminalRunner {
  async run(
    action: RunCommandAction,
    options: CommandExecutionOptions,
    onChunk: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<CommandResult> {
    const cwd = this.resolveCwd(action.cwd);
    const cwdLabel = action.cwd?.trim() || ".";
    const startedAt = Date.now();
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(action.command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: commandEnvironment(process.env)
      });

      let stdout: BoundedOutput = { text: "", truncated: false };
      let stderr: BoundedOutput = { text: "", truncated: false };
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, Math.max(1, options.timeoutSeconds) * 1000);
      const abort = (): void => {
        cancelled = true;
        child.kill("SIGTERM");
      };

      if (options.signal?.aborted) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const next = appendBounded(stdout, text, options.outputLimitBytes);
        emitBoundedChunk("stdout", text, stdout.truncated, next.truncated, onChunk);
        stdout = next;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const next = appendBounded(stderr, text, options.outputLimitBytes);
        emitBoundedChunk("stderr", text, stderr.truncated, next.truncated, onChunk);
        stderr = next;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (settled) {
          return;
        }
        settled = true;
        stderr = appendBounded(stderr, error.message, options.outputLimitBytes);
        resolve({
          exitCode: 1,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut,
          cancelled,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputLimitBytes: options.outputLimitBytes,
          cwd: cwdLabel,
          startedAt,
          endedAt: Date.now()
        });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          exitCode,
          signal,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut,
          cancelled,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputLimitBytes: options.outputLimitBytes,
          cwd: cwdLabel,
          startedAt,
          endedAt: Date.now()
        });
      });
    });
  }

  private resolveCwd(cwd: string | undefined): string {
    if (!cwd || cwd === ".") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        throw new Error("CodeForge requires an open repo folder to run commands.");
      }
      return folder.uri.fsPath;
    }

    return resolveWorkspaceUri(cwd).fsPath;
  }
}

interface BoundedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

function appendBounded(current: BoundedOutput, next: string, maxBytes: number): BoundedOutput {
  const limit = Math.max(1024, maxBytes);
  const combined = current.text + next;
  if (Buffer.byteLength(combined, "utf8") <= limit) {
    return { text: combined, truncated: current.truncated };
  }
  const marker = "\n[CodeForge kept the end of this stream because the command output limit was reached.]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const tailBudget = Math.max(1, limit - markerBytes);
  const tail = Buffer.from(combined).subarray(Math.max(0, Buffer.byteLength(combined, "utf8") - tailBudget)).toString("utf8");
  return { text: `${marker}${tail}`, truncated: true };
}

function emitBoundedChunk(
  stream: "stdout" | "stderr",
  text: string,
  wasTruncated: boolean,
  isTruncated: boolean,
  onChunk: (stream: "stdout" | "stderr", text: string) => void
): void {
  if (!wasTruncated && !isTruncated) {
    onChunk(stream, text);
    return;
  }
  if (!wasTruncated && isTruncated) {
    onChunk(stream, `[CodeForge stopped streaming ${stream} because the command output limit was reached.]\n`);
  }
}

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT"
  ];
  const env: NodeJS.ProcessEnv = {
    CODEFORGE: "1",
    NO_COLOR: "1"
  };
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
