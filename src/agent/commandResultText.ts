import { formatBytes } from "../core/contextUsage";
import { CommandResult, RunCommandAction } from "../core/types";

// Render a finished shell command into the transcript text the model reads back (status, timing,
// truncation notes, and the captured stdout/stderr).
export function formatCommandResult(action: RunCommandAction, result: CommandResult): string {
  const status = result.timedOut
    ? `timed out after command timeout`
    : result.cancelled
      ? "cancelled by user"
    : `exited with ${result.exitCode ?? result.signal ?? "unknown"}`;
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `run_command ${action.command}`,
    "",
    `CWD: ${result.cwd}`,
    `Status: ${status}`,
    `Duration: ${Math.max(0, result.endedAt - result.startedAt)}ms`,
    `Output limit: ${formatBytes(result.outputLimitBytes)} per stream`,
    result.stdoutTruncated ? "STDOUT was truncated to the configured output limit." : undefined,
    stdout ? `STDOUT:\n${stdout}` : "STDOUT: (empty)",
    result.stderrTruncated ? "STDERR was truncated to the configured output limit." : undefined,
    stderr ? `STDERR:\n${stderr}` : "STDERR: (empty)"
  ].filter((line): line is string => Boolean(line)).join("\n");
}

// One-line status for a hook command that failed, used in the inline hook-failure notice.
export function hookFailureStatus(result: CommandResult): string {
  if (result.timedOut) {
    return "Command timed out.";
  }
  if (result.cancelled) {
    return "Command was cancelled.";
  }
  return `Command exited with ${result.exitCode ?? result.signal ?? "unknown"}.`;
}
