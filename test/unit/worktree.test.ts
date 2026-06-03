import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { GitWorktreeManager } from "../../src/adapters/worktree";

const run = promisify(execFile);

test("GitWorktreeManager isolates edits in a throwaway worktree and captures a diff", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-wt-repo-"));
  try {
    await run("git", ["-C", repo, "init", "-q"]);
    await run("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "original\n");
    await run("git", ["-C", repo, "add", "-A"]);
    await run("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    const manager = new GitWorktreeManager(repo);
    assert.equal(await manager.isAvailable(), true);

    const handle = await manager.create("worker-1", 1234);
    assert.equal(await pathExists(handle.path), true);
    // The worktree starts as a clean checkout of HEAD.
    assert.equal(await fs.readFile(path.join(handle.path, "a.txt"), "utf8"), "original\n");

    // Edits in the worktree must not touch the main tree.
    await fs.writeFile(path.join(handle.path, "a.txt"), "changed\n");
    await fs.writeFile(path.join(handle.path, "b.txt"), "brand new\n");
    assert.equal(await fs.readFile(path.join(repo, "a.txt"), "utf8"), "original\n", "main tree stays untouched");
    assert.equal(await pathExists(path.join(repo, "b.txt")), false);

    const changed = await manager.changedFiles(handle);
    assert.deepEqual([...changed].sort(), ["a.txt", "b.txt"]);

    const diff = await manager.captureDiff(handle);
    assert.match(diff, /a\.txt/);
    assert.match(diff, /\+changed/);
    assert.match(diff, /b\.txt/);
    assert.match(diff, /\+brand new/);

    await manager.remove(handle);
    assert.equal(await pathExists(handle.path), false, "worktree directory is cleaned up");
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("isAvailable is false outside a git repository", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-wt-nogit-"));
  try {
    assert.equal(await new GitWorktreeManager(dir).isAvailable(), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
