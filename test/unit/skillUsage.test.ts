import test from "node:test";
import assert from "node:assert/strict";
import { SkillUsageTracker, latestActivityAt, activityCount } from "../../src/core/skillUsage";
import { fakeSkillIo } from "./helpers/fakeSkillIo";

let clock = 0;
const nowIso = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();

function tracker() {
  clock = 0;
  return new SkillUsageTracker(fakeSkillIo(), nowIso);
}

test("bumps create activity counters and timestamps", async () => {
  const usage = tracker();
  await usage.bumpUse("alpha");
  await usage.bumpView("alpha");
  await usage.bumpView("alpha");
  await usage.bumpPatch("alpha");
  const records = await usage.records();
  assert.equal(records.alpha.use_count, 1);
  assert.equal(records.alpha.view_count, 2);
  assert.equal(records.alpha.patch_count, 1);
  assert.ok(records.alpha.last_used_at && records.alpha.last_viewed_at && records.alpha.last_patched_at);
  assert.equal(activityCount(records.alpha), 4);
});

test("provenance gates curation eligibility", async () => {
  const usage = tracker();
  await usage.bumpView("beta");
  assert.equal(await usage.isCurationEligible("beta"), false);
  await usage.markAgentCreated("beta");
  assert.equal(await usage.isCurationEligible("beta"), true);
  assert.equal(await usage.isAgentCreated("beta"), true);
  const report = await usage.agentCreatedReport();
  assert.deepEqual(report.map((row) => row.name), ["beta"]);
});

test("lifecycle state and pin flags", async () => {
  const usage = tracker();
  await usage.ensure("gamma");
  await usage.setState("gamma", "archived");
  let records = await usage.records();
  assert.equal(records.gamma.state, "archived");
  assert.ok(records.gamma.archived_at);
  // Re-use reactivates a stale skill, but not an archived one.
  await usage.setState("gamma", "stale");
  await usage.bumpUse("gamma");
  records = await usage.records();
  assert.equal(records.gamma.state, "active");

  await usage.setPinned("gamma", true);
  assert.equal(await usage.isPinned("gamma"), true);
});

test("latestActivityAt excludes created_at and returns null when never used", () => {
  assert.equal(
    latestActivityAt({
      created_by: null,
      use_count: 0,
      view_count: 0,
      patch_count: 0,
      last_used_at: null,
      last_viewed_at: null,
      last_patched_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      state: "active",
      pinned: false,
      archived_at: null
    }),
    null
  );
});

test("concurrent bumps serialize without clobbering", async () => {
  const usage = tracker();
  await Promise.all(Array.from({ length: 20 }, () => usage.bumpView("delta")));
  const records = await usage.records();
  assert.equal(records.delta.view_count, 20);
});
