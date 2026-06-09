// Skill usage tracking — TS port of Hermes `tools/skill_usage.py`.
//
// A local sidecar at `.codeforge/skills/.usage.json` that records, per skill: provenance
// (created_by), activity counters (use/view/patch + timestamps), lifecycle state
// (active/stale/archived), and a pinned flag. Purely local bookkeeping — nothing is sent
// anywhere. The curator (later phase) reads this to auto-transition and consolidate skills;
// only skills with `created_by: "agent"` are ever eligible for curation.

import { SkillIo, USAGE_FILE } from "./skillIo";

export type SkillState = "active" | "stale" | "archived";

export interface SkillUsageRecord {
  created_by: "agent" | null;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_viewed_at: string | null;
  last_patched_at: string | null;
  created_at: string;
  state: SkillState;
  pinned: boolean;
  archived_at: string | null;
}

export interface SkillUsageReportRow extends SkillUsageRecord {
  readonly name: string;
  readonly latestActivityAt: string | null;
  readonly activityCount: number;
}

type UsageMap = Record<string, SkillUsageRecord>;

export class SkillUsageTracker {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly io: SkillIo, private readonly nowIso: () => string = () => new Date().toISOString()) {}

  async records(): Promise<UsageMap> {
    return this.load();
  }

  async report(): Promise<readonly SkillUsageReportRow[]> {
    const records = await this.load();
    return Object.entries(records).map(([name, record]) => ({
      name,
      ...record,
      latestActivityAt: latestActivityAt(record),
      activityCount: activityCount(record)
    }));
  }

  /** Agent-created skills only — the set the curator is allowed to manage. */
  async agentCreatedReport(): Promise<readonly SkillUsageReportRow[]> {
    return (await this.report()).filter((row) => row.created_by === "agent");
  }

  async isAgentCreated(name: string): Promise<boolean> {
    return (await this.load())[name]?.created_by === "agent";
  }

  async isCurationEligible(name: string): Promise<boolean> {
    return this.isAgentCreated(name);
  }

  async isPinned(name: string): Promise<boolean> {
    return Boolean((await this.load())[name]?.pinned);
  }

  async ensure(name: string): Promise<void> {
    await this.update(name, () => undefined);
  }

  async markAgentCreated(name: string): Promise<void> {
    await this.update(name, (record) => {
      record.created_by = "agent";
    });
  }

  async bumpUse(name: string): Promise<void> {
    await this.update(name, (record) => {
      record.use_count += 1;
      record.last_used_at = this.nowIso();
      if (record.state === "stale") {
        record.state = "active";
      }
    });
  }

  async bumpView(name: string): Promise<void> {
    await this.update(name, (record) => {
      record.view_count += 1;
      record.last_viewed_at = this.nowIso();
    });
  }

  async bumpPatch(name: string): Promise<void> {
    await this.update(name, (record) => {
      record.patch_count += 1;
      record.last_patched_at = this.nowIso();
    });
  }

  async setState(name: string, state: SkillState): Promise<void> {
    await this.update(name, (record) => {
      record.state = state;
      record.archived_at = state === "archived" ? this.nowIso() : null;
    });
  }

  async setPinned(name: string, pinned: boolean): Promise<void> {
    await this.update(name, (record) => {
      record.pinned = pinned;
    });
  }

  /** Drop a skill's record entirely (e.g. when it is renamed away). */
  async forget(name: string): Promise<void> {
    await this.run(async () => {
      const records = await this.load();
      if (records[name]) {
        delete records[name];
        await this.save(records);
      }
    });
  }

  // -- Internals ------------------------------------------------------------

  private emptyRecord(): SkillUsageRecord {
    return {
      created_by: null,
      use_count: 0,
      view_count: 0,
      patch_count: 0,
      last_used_at: null,
      last_viewed_at: null,
      last_patched_at: null,
      created_at: this.nowIso(),
      state: "active",
      pinned: false,
      archived_at: null
    };
  }

  private async load(): Promise<UsageMap> {
    const raw = await this.io.read(USAGE_FILE);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as UsageMap) : {};
    } catch {
      return {};
    }
  }

  private async save(records: UsageMap): Promise<void> {
    await this.io.write(USAGE_FILE, `${JSON.stringify(records, null, 2)}\n`);
  }

  // Serialize a read-modify-write of the sidecar so concurrent bumps never clobber each other.
  private async update(name: string, apply: (record: SkillUsageRecord) => void): Promise<void> {
    await this.run(async () => {
      const records = await this.load();
      const record = records[name] ?? this.emptyRecord();
      apply(record);
      records[name] = record;
      await this.save(records);
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    await this.queue;
  }
}

export function activityCount(record: SkillUsageRecord): number {
  return record.use_count + record.view_count + record.patch_count;
}

// Newest of the activity timestamps, intentionally EXCLUDING created_at so callers can tell a
// never-used skill (null) from one that has been touched.
export function latestActivityAt(record: SkillUsageRecord): string | null {
  const stamps = [record.last_used_at, record.last_viewed_at, record.last_patched_at].filter(
    (value): value is string => Boolean(value)
  );
  if (stamps.length === 0) {
    return null;
  }
  return stamps.reduce((latest, value) => (value > latest ? value : latest));
}
