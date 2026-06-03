import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEntry } from "../../src/core/memory";
import { LearnedLesson, parseLesson, serializeLessonText } from "../../src/core/learning";
import { buildAuditPrompt, overflowEvictions, parseAuditPlan } from "../../src/core/learningAudit";

function lesson(body: string, id: string, createdAt: number): LearnedLesson {
  const entry: MemoryEntry = {
    id,
    text: serializeLessonText({ kind: "fact", outcome: "success", status: "accepted", paths: [], body }),
    createdAt,
    scope: "workspace"
  };
  return parseLesson(entry)!;
}

test("buildAuditPrompt enumerates lessons and states the cap", () => {
  const { system, user } = buildAuditPrompt([lesson("alpha", "a", 1), lesson("beta", "b", 2)], 5);
  assert.match(system, /at most 5 lessons/);
  assert.match(user, /1\. \[fact\/success\] alpha/);
  assert.match(user, /2\. \[fact\/success\] beta/);
});

test("parseAuditPlan validates indices and tolerates code fences", () => {
  const plan = parseAuditPlan("```json\n{\"drop\":[2,9,\"3\"],\"rewrite\":[{\"i\":1,\"text\":\"sharper\"},{\"i\":2,\"text\":\"ignored because dropped\"}]}\n```", 3);
  assert.deepEqual([...plan.drop].sort(), [2, 3]);
  assert.equal(plan.rewrite.length, 1);
  assert.deepEqual(plan.rewrite[0], { index: 1, text: "sharper" });

  assert.deepEqual(parseAuditPlan("garbage", 3), { drop: [], rewrite: [] });
});

test("overflowEvictions removes the oldest lessons beyond the cap", () => {
  const lessons = [lesson("old", "old", 1), lesson("mid", "mid", 2), lesson("new", "new", 3)];
  assert.deepEqual(overflowEvictions(lessons, 2), ["old"]);
  assert.deepEqual(overflowEvictions(lessons, 3), []);
  assert.deepEqual([...overflowEvictions(lessons, 1)].sort(), ["mid", "old"]);
});
