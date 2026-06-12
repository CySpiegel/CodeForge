import test from "node:test";
import assert from "node:assert/strict";
import { SessionRecord } from "../../src/core/session";
import { TaskBoard } from "../../src/agent/taskBoard";

function makeBoard() {
  const records: SessionRecord[] = [];
  let publishCount = 0;
  const board = new TaskBoard({
    record: async (factory) => {
      records.push(factory("session-1"));
    },
    publishState: async () => {
      publishCount += 1;
    }
  });
  return { board, records, publishCount: () => publishCount };
}

test("createTask normalizes fields, dedups, and persists a created record", async () => {
  const { board, records, publishCount } = makeBoard();
  const out = await board.createTask({
    type: "task_create",
    subject: "  Do the thing  ",
    description: "  desc  ",
    owner: "   ",
    blocks: ["a", "a", " b "],
    blockedBy: []
  });

  assert.match(out, /^task_create task-/);
  assert.match(out, /Status: pending/);
  assert.match(out, /Subject: Do the thing/);
  assert.match(out, /Description: desc/);
  assert.match(out, /Blocks: a, b/); // trimmed + deduped
  assert.doesNotMatch(out, /Owner:/); // blank owner -> undefined, line omitted
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "task");
  assert.equal(publishCount(), 1);
});

test("updateTask merges fields, stamps completedAt, and errors on unknown id", async () => {
  const { board } = makeBoard();
  const created = await board.createTask({ type: "task_create", subject: "one", blocks: [], blockedBy: [] });
  const id = created.match(/task_create (task-[^\n]+)/)![1];

  const updated = await board.updateTask({ type: "task_update", taskId: id, status: "completed", owner: "alice" });
  assert.match(updated, /Status: completed/);
  assert.match(updated, /Owner: alice/);
  assert.match(updated, /Completed: /);

  const missing = await board.updateTask({ type: "task_update", taskId: "task-nope", status: "completed" });
  assert.match(missing, /No task found for task-nope/);
});

test("listTasks filters by status and owner; getTask fetches or reports missing", async () => {
  const { board } = makeBoard();
  await board.createTask({ type: "task_create", subject: "a", owner: "alice", blocks: [], blockedBy: [] });
  const second = await board.createTask({ type: "task_create", subject: "b", owner: "bob", blocks: [], blockedBy: [] });
  const bobId = second.match(/task_create (task-[^\n]+)/)![1];

  assert.match(board.listTasks({ type: "task_list", owner: "alice" }), /a/);
  assert.doesNotMatch(board.listTasks({ type: "task_list", owner: "alice" }), /Subject/); // line form, not detail
  assert.match(board.listTasks({ type: "task_list", owner: "alice" }), /\[pending\]/);
  assert.doesNotMatch(board.listTasks({ type: "task_list", owner: "alice" }), /owner=bob/);
  assert.equal(board.listTasks({ type: "task_list", status: "completed" }), "task_list\n\nNo tasks.");

  assert.match(board.getTask(bobId), new RegExp(`task_get ${bobId}`));
  assert.match(board.getTask("task-nope"), /No task found for task-nope/);
});

test("restoreFromSessionRecords rehydrates only task records; reset clears", async () => {
  const { board } = makeBoard();
  const taskRecord: SessionRecord = {
    type: "task",
    sessionId: "s1",
    createdAt: 1,
    event: "created",
    task: {
      id: "task-restored",
      subject: "restored",
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: 1,
      updatedAt: 1
    }
  };
  board.restoreFromSessionRecords([taskRecord]);
  assert.match(board.getTask("task-restored"), /Subject: restored/);

  board.reset();
  assert.match(board.getTask("task-restored"), /No task found/);
});
