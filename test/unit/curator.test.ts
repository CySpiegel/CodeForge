import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutomaticTransitions,
  CuratorSettings,
  defaultCuratorState,
  parseCuratorSummary,
  shouldRunCurator
} from "../../src/core/curator";
import { SkillUsageRecord, SkillUsageTracker } from "../../src/core/skillUsage";
import { USAGE_FILE, skillMdPath, archivedSkillDirPath } from "../../src/core/skillIo";
import { fakeSkillIo, FakeSkillIo } from "./helpers/fakeSkillIo";

const SETTINGS: CuratorSettings = {
  enabled: true,
  intervalHours: 168,
  minIdleHours: 2,
  staleAfterDays: 30,
  archiveAfterDays: 90,
  backupEnabled: true,
  backupKeep: 5
};

const NOW = Date.parse("2026-04-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function record(overrides: Partial<SkillUsageRecord>): SkillUsageRecord {
  return {
    created_by: "agent",
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: daysAgo(200),
    state: "active",
    pinned: false,
    archived_at: null,
    ...overrides
  };
}

function seed(io: FakeSkillIo, records: Record<string, SkillUsageRecord>) {
  io.files.set(USAGE_FILE, JSON.stringify(records));
  for (const name of Object.keys(records)) {
    io.files.set(skillMdPath(name), `---\nname: ${name}\ndescription: d\n---\nbody`);
  }
}

test("shouldRunCurator gates on enabled/paused/interval/first-run/idle", () => {
  assert.equal(shouldRunCurator(defaultCuratorState(), NOW, { ...SETTINGS, enabled: false }).reason, "disabled");
  assert.equal(shouldRunCurator({ ...defaultCuratorState(), paused: true, lastRunAt: 0 }, NOW, SETTINGS).reason, "paused");

  const firstRun = shouldRunCurator(defaultCuratorState(), NOW, SETTINGS);
  assert.equal(firstRun.run, false);
  assert.equal(firstRun.seedFirstRun, true);

  assert.equal(shouldRunCurator({ ...defaultCuratorState(), lastRunAt: NOW - 3_600_000 }, NOW, SETTINGS).run, false);

  const due = { ...defaultCuratorState(), lastRunAt: NOW - 200 * 3_600_000 };
  assert.equal(shouldRunCurator(due, NOW, SETTINGS).run, true);
  // Idle gate only enforced when a measurement is supplied.
  assert.equal(shouldRunCurator(due, NOW, SETTINGS, 60).run, false);
  assert.equal(shouldRunCurator(due, NOW, SETTINGS, 3 * 3600).run, true);
});

test("applyAutomaticTransitions moves skills by inactivity and exempts pinned", async () => {
  const io = fakeSkillIo();
  seed(io, {
    fresh: record({ last_used_at: daysAgo(1) }),
    goingStale: record({ last_used_at: daysAgo(45), state: "active" }),
    oldArchive: record({ last_used_at: daysAgo(120), state: "active" }),
    reactivated: record({ last_used_at: daysAgo(1), state: "stale" }),
    pinnedOld: record({ last_used_at: daysAgo(200), state: "active", pinned: true })
  });
  const usage = new SkillUsageTracker(io, () => new Date(NOW).toISOString());

  const counts = await applyAutomaticTransitions(io, usage, SETTINGS, NOW);
  assert.equal(counts.markedStale, 1);
  assert.equal(counts.archived, 1);
  assert.equal(counts.reactivated, 1);

  const records = await usage.records();
  assert.equal(records.fresh.state, "active");
  assert.equal(records.goingStale.state, "stale");
  assert.equal(records.oldArchive.state, "archived");
  assert.equal(records.reactivated.state, "active");
  assert.equal(records.pinnedOld.state, "active");

  // Archived skill's directory was moved into .archive/.
  assert.ok(io.files.has(`${archivedSkillDirPath("oldArchive")}/SKILL.md`));
  assert.ok(!io.files.has(skillMdPath("oldArchive")));
});

test("dry-run counts transitions without mutating", async () => {
  const io = fakeSkillIo();
  seed(io, { goingStale: record({ last_used_at: daysAgo(45) }) });
  const usage = new SkillUsageTracker(io, () => new Date(NOW).toISOString());
  const counts = await applyAutomaticTransitions(io, usage, SETTINGS, NOW, false);
  assert.equal(counts.markedStale, 1);
  assert.equal((await usage.records()).goingStale.state, "active");
});

test("only agent-created skills are touched", async () => {
  const io = fakeSkillIo();
  seed(io, { manual: record({ created_by: null, last_used_at: daysAgo(200) }) });
  const usage = new SkillUsageTracker(io, () => new Date(NOW).toISOString());
  const counts = await applyAutomaticTransitions(io, usage, SETTINGS, NOW);
  assert.equal(counts.checked, 0);
  assert.equal((await usage.records()).manual.state, "active");
});

test("parseCuratorSummary extracts consolidations and prunings", () => {
  const text = [
    "## Structured summary",
    "```yaml",
    "consolidations:",
    "  - from: pr-123-fix",
    "    into: pr-review",
    "    reason: same class",
    "prunings:",
    "  - name: one-off-thing",
    "    reason: stale",
    "```"
  ].join("\n");
  const parsed = parseCuratorSummary(text);
  assert.deepEqual(parsed.consolidations, [{ from: "pr-123-fix", into: "pr-review" }]);
  assert.deepEqual(parsed.prunings, [{ name: "one-off-thing" }]);
});
