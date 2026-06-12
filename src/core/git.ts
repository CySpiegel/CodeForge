// Git port: the agent layer depends on this vscode-free interface so it can default to the
// Unavailable implementation in tests. The real GitService adapter (src/adapters/gitService.ts) wires
// the workspace-scoped git binary.

export interface GitCommandResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitPort {
  // Run a git subcommand (argv, never a shell string) in the workspace root. Callers build argv from a
  // validated allowlist, so the port itself does not sanitize.
  run(args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult>;
}

// Default when no git adapter is wired (unit harness, or no workspace): every operation reports git as
// unavailable rather than throwing.
export class UnavailableGitPort implements GitPort {
  async run(): Promise<GitCommandResult> {
    return { ok: false, exitCode: -1, stdout: "", stderr: "Git is not available in this environment." };
  }
}
