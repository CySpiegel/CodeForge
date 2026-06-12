import test from "node:test";
import assert from "node:assert/strict";
import { readFileContentFromToolResult, ReadStateTracker } from "../../src/agent/readStateTracker";

test("remember + snapshotFor round-trips and normalizes the path key", () => {
  const tracker = new ReadStateTracker();
  tracker.remember("src/a.ts", "hello", 48000, "tool");

  const snap = tracker.snapshotFor("src/a.ts");
  assert.ok(snap);
  assert.equal(snap.content, "hello");
  assert.equal(snap.maxBytes, 48000);
  assert.equal(snap.source, "tool");

  // Leading "./" is stripped, so the same file under a different surface form hits the same snapshot.
  assert.equal(tracker.snapshotFor("./src/a.ts")?.content, "hello");
  assert.equal(tracker.snapshotFor("other.ts"), undefined);
});

test("forget removes the snapshot", () => {
  const tracker = new ReadStateTracker();
  tracker.remember("src/a.ts", "x", 10, "worker");
  tracker.forget("src/a.ts");
  assert.equal(tracker.snapshotFor("src/a.ts"), undefined);
});

test("notebook read state is tracked and normalized", () => {
  const tracker = new ReadStateTracker();
  assert.equal(tracker.hasNotebookRead("nb.ipynb"), false);
  tracker.markNotebookRead("nb.ipynb");
  assert.equal(tracker.hasNotebookRead("nb.ipynb"), true);
  assert.equal(tracker.hasNotebookRead("./nb.ipynb"), true);
  assert.equal(tracker.hasNotebookRead("other.ipynb"), false);
});

test("clear empties both collections", () => {
  const tracker = new ReadStateTracker();
  tracker.remember("src/a.ts", "x", 10, "tool");
  tracker.markNotebookRead("nb.ipynb");
  tracker.clear();
  assert.equal(tracker.snapshotFor("src/a.ts"), undefined);
  assert.equal(tracker.hasNotebookRead("nb.ipynb"), false);
});

test("readFileContentFromToolResult strips the read_file header", () => {
  assert.equal(readFileContentFromToolResult("read_file src/a.ts\n\nbody here", "src/a.ts"), "body here");
  // Falls back to the generic header strip when the exact path prefix does not match.
  assert.equal(readFileContentFromToolResult("read_file other\n\nbody", "src/a.ts"), "body");
  // No header -> the generic strip leaves content that does not start with read_file untouched.
  assert.equal(readFileContentFromToolResult("plain content", "src/a.ts"), "plain content");
});
