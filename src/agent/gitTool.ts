import { GitCommandResult, GitPort } from "../core/git";
import { GitAction } from "../core/types";

const gitOutputLimitBytes = 200_000;

// Safe flags the read-only git tool may forward. Everything else starting with "-" is rejected so the
// model cannot smuggle dangerous options (e.g. --output, --upload-pack, -c) through the git port.
const gitFlagAllowlist = new Set([
  "--cached", "--staged", "--stat", "--name-only", "--name-status", "-p", "--patch", "--decorate", "--oneline", "--graph", "-n"
]);

// Build the exact argv for a read-only git operation from a fixed safe base plus validated extras.
// Returns undefined when an argument is unsafe, so the caller surfaces a tool error instead of running.
export function buildGitArgv(action: GitAction): readonly string[] | undefined {
  const extra = sanitizeGitArgs(action.args);
  if (extra === undefined) {
    return undefined;
  }
  switch (action.operation) {
    case "status":
      return ["status", "--short", "--branch", ...extra];
    case "diff":
      return ["diff", ...extra];
    case "log":
      return extra.length > 0 ? ["log", "--oneline", "--decorate", ...extra] : ["log", "--oneline", "--decorate", "-n", "30"];
    case "show":
      return ["show", "--stat", ...extra];
    case "branch":
      return ["branch", "--all", "--verbose", ...extra];
  }
}

// Validate model-supplied extra git args token by token. Flags must be in the allowlist; other tokens
// must be a plain ref / range / repo-relative path (no shell metacharacters — args are passed as argv,
// and git bounds pathspecs to the repo). Returns the token list, or undefined if anything is unsafe.
export function sanitizeGitArgs(args: string | undefined): readonly string[] | undefined {
  if (!args || !args.trim()) {
    return [];
  }
  const tokens = args.trim().split(/\s+/);
  if (tokens.length > 8) {
    return undefined;
  }
  const safe: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) {
      if (gitFlagAllowlist.has(token) || /^-n\d+$/.test(token)) {
        safe.push(token);
        continue;
      }
      return undefined;
    }
    if (/^\d+$/.test(token) && safe[safe.length - 1] === "-n") {
      safe.push(token);
      continue;
    }
    if (/^[A-Za-z0-9_./@^~-]+$/.test(token)) {
      safe.push(token);
      continue;
    }
    return undefined;
  }
  return safe;
}

export function unsafeGitArgsMessage(action: GitAction): string {
  return `git ${action.operation}: unsupported or unsafe arguments. Allowed extras are a ref, a repo-relative path, or a safe flag (--cached, --stat, --name-only, -p, -n <count>).`;
}

// Run a validated read-only git operation and format the result for the model transcript. Returns the
// formatted text, or undefined when the arguments are unsafe (caller turns that into a tool error).
export async function runGitOperation(gitPort: GitPort, action: GitAction, signal?: AbortSignal): Promise<string | undefined> {
  const argv = buildGitArgv(action);
  if (!argv) {
    return undefined;
  }
  const result = await gitPort.run(argv, signal);
  return formatGitResult(action, result);
}

function formatGitResult(action: GitAction, result: GitCommandResult): string {
  const raw = result.ok
    ? (result.stdout.trim() || "(no output)")
    : `git ${action.operation} failed (exit ${result.exitCode}).\n${(result.stderr || result.stdout).trim() || "no output"}`;
  const clipped = Buffer.byteLength(raw, "utf8") > gitOutputLimitBytes
    ? `${Buffer.from(raw, "utf8").subarray(0, gitOutputLimitBytes).toString("utf8")}\n…[git output clipped]`
    : raw;
  return `git ${action.operation}${action.args ? ` ${action.args}` : ""}\n\n${clipped}`;
}
