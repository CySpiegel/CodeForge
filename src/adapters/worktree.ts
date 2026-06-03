import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const run = promisify(execFile);
const diffMaxBuffer = 64 * 1024 * 1024;

export interface WorktreeHandle {
  readonly id: string;
  readonly path: string;
}

// Git worktree isolation for parallel editing sub-agents. Each editing worker gets a throwaway
// detached worktree at HEAD; its writes stay isolated there, and the captured diff is surfaced
// back to the main tree through the normal approval path (propose_patch) rather than applied
// silently. Read-only workers never need this.
export class GitWorktreeManager {
  constructor(private readonly repoRoot: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async create(id: string, now: number): Promise<WorktreeHandle> {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "worker";
    const dir = path.join(os.tmpdir(), `codeforge-wt-${safe}-${now}`);
    await this.git(["worktree", "add", "--detach", dir, "HEAD"]);
    return { id, path: dir };
  }

  // Stage everything the worker changed and return a patch vs HEAD (covers new and deleted files).
  async captureDiff(handle: WorktreeHandle): Promise<string> {
    await run("git", ["-C", handle.path, "add", "-A"]);
    const { stdout } = await run("git", ["-C", handle.path, "diff", "--cached", "HEAD"], { maxBuffer: diffMaxBuffer });
    return stdout;
  }

  async changedFiles(handle: WorktreeHandle): Promise<readonly string[]> {
    await run("git", ["-C", handle.path, "add", "-A"]);
    const { stdout } = await run("git", ["-C", handle.path, "diff", "--cached", "--name-only", "HEAD"]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async remove(handle: WorktreeHandle): Promise<void> {
    try {
      await this.git(["worktree", "remove", "--force", handle.path]);
    } catch {
      // Fall back to a manual cleanup if the worktree metadata is already gone.
      await fs.rm(handle.path, { recursive: true, force: true }).catch(() => undefined);
      await this.git(["worktree", "prune"]).catch(() => undefined);
    }
  }

  private git(args: readonly string[]): ReturnType<typeof run> {
    return run("git", ["-C", this.repoRoot, ...args]);
  }
}
