import test from "node:test";
import assert from "node:assert/strict";
import { listBackups, pruneBackups, rollbackSkills, snapshotSkills } from "../../src/core/curatorBackup";
import { skillMdPath } from "../../src/core/skillIo";
import { fakeSkillIo } from "./helpers/fakeSkillIo";

const T1 = Date.parse("2026-04-01T00:00:00.000Z");
const T2 = Date.parse("2026-04-08T00:00:00.000Z");
const T3 = Date.parse("2026-04-15T00:00:00.000Z");

test("snapshot then rollback restores the skill library", async () => {
  const io = fakeSkillIo({
    [skillMdPath("alpha")]: "alpha v1",
    [skillMdPath("beta")]: "beta v1"
  });

  const info = await snapshotSkills(io, T1, 5);
  assert.equal(info.fileCount, 2);
  assert.deepEqual(await listBackups(io), [info.id]);

  // Mutate: drop beta, change alpha.
  io.files.delete(skillMdPath("beta"));
  io.files.set(skillMdPath("alpha"), "alpha v2");

  const result = await rollbackSkills(io, info.id, T2, 5);
  assert.equal(result.ok, true);
  assert.equal(io.files.get(skillMdPath("alpha")), "alpha v1");
  assert.equal(io.files.get(skillMdPath("beta")), "beta v1");
});

test("pruneBackups keeps only the newest N", async () => {
  const io = fakeSkillIo({ [skillMdPath("alpha")]: "a" });
  const b1 = await snapshotSkills(io, T1, 5);
  const b2 = await snapshotSkills(io, T2, 5);
  const b3 = await snapshotSkills(io, T3, 5);
  assert.deepEqual([...(await listBackups(io))].sort(), [b1.id, b2.id, b3.id].sort());

  await pruneBackups(io, 2);
  const remaining = await listBackups(io);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(b3.id));
  assert.ok(!remaining.includes(b1.id));
});

test("rollback to a missing backup fails cleanly", async () => {
  const io = fakeSkillIo({ [skillMdPath("alpha")]: "a" });
  const result = await rollbackSkills(io, "nope", T1, 5);
  assert.equal(result.ok, false);
  assert.match(result.message, /No backup/);
});
