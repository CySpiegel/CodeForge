// The curator — long-horizon skill-library maintenance, ported/adapted from Hermes `agent/curator.py`.
//
// Two passes: (a) a deterministic lifecycle sweep that moves agent-created skills active→stale→
// archived from their usage timestamps (and reactivates re-used ones); (b) an LLM "umbrella-building"
// consolidation that merges narrow skills into class-level umbrellas. It NEVER deletes (archive is the
// max), exempts pinned skills, and only touches agent-created skills. The LLM pass runs as a separate
// conversation (orchestrated by the controller) so it never disturbs the main session's prompt cache.

import { archivedSkillDirPath, CURATOR_STATE_FILE, flatSkillPath, skillDirPath, SkillIo } from "./skillIo";
import { SkillUsageReportRow, SkillUsageTracker } from "./skillUsage";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface CuratorSettings {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly minIdleHours: number;
  readonly staleAfterDays: number;
  readonly archiveAfterDays: number;
  readonly backupEnabled: boolean;
  readonly backupKeep: number;
}

export interface CuratorState {
  lastRunAt: number | null;
  lastRunDurationMs: number | null;
  lastRunSummary: string | null;
  runCount: number;
  paused: boolean;
}

export interface TransitionCounts {
  checked: number;
  markedStale: number;
  archived: number;
  reactivated: number;
}

export function defaultCuratorState(): CuratorState {
  return { lastRunAt: null, lastRunDurationMs: null, lastRunSummary: null, runCount: 0, paused: false };
}

export async function readCuratorState(io: SkillIo): Promise<CuratorState> {
  const raw = await io.read(CURATOR_STATE_FILE);
  if (!raw) {
    return defaultCuratorState();
  }
  try {
    return { ...defaultCuratorState(), ...(JSON.parse(raw) as Partial<CuratorState>) };
  } catch {
    return defaultCuratorState();
  }
}

export async function writeCuratorState(io: SkillIo, state: CuratorState): Promise<void> {
  await io.write(CURATOR_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function parseIso(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Gate for an automatic curator run. Mirrors Hermes `should_run_now` + the idle check. */
export function shouldRunCurator(
  state: CuratorState,
  nowMs: number,
  settings: CuratorSettings,
  idleForSeconds?: number
): { readonly run: boolean; readonly reason: string; readonly seedFirstRun: boolean } {
  if (!settings.enabled) {
    return { run: false, reason: "disabled", seedFirstRun: false };
  }
  if (state.paused) {
    return { run: false, reason: "paused", seedFirstRun: false };
  }
  if (state.lastRunAt == null) {
    // First-run deferral: seed last_run_at to now, don't run yet.
    return { run: false, reason: "deferred first run — seeded; will run after one interval", seedFirstRun: true };
  }
  if (nowMs - state.lastRunAt < settings.intervalHours * HOUR_MS) {
    return { run: false, reason: "interval not elapsed", seedFirstRun: false };
  }
  if (idleForSeconds != null && idleForSeconds < settings.minIdleHours * 3600) {
    return { run: false, reason: "not idle long enough", seedFirstRun: false };
  }
  return { run: true, reason: "due", seedFirstRun: false };
}

/** Deterministic lifecycle sweep over agent-created, non-pinned skills. */
export async function applyAutomaticTransitions(
  io: SkillIo,
  usage: SkillUsageTracker,
  settings: CuratorSettings,
  nowMs: number,
  apply = true
): Promise<TransitionCounts> {
  const counts: TransitionCounts = { checked: 0, markedStale: 0, archived: 0, reactivated: 0 };
  const staleCutoff = nowMs - settings.staleAfterDays * DAY_MS;
  const archiveCutoff = nowMs - settings.archiveAfterDays * DAY_MS;

  for (const row of await usage.agentCreatedReport()) {
    counts.checked += 1;
    if (row.pinned) {
      continue;
    }
    const anchor = parseIso(row.latestActivityAt) ?? parseIso(row.created_at) ?? nowMs;
    if (anchor <= archiveCutoff && row.state !== "archived") {
      if (apply) {
        await archiveSkillFiles(io, row.name);
        await usage.setState(row.name, "archived");
      }
      counts.archived += 1;
    } else if (anchor <= staleCutoff && row.state === "active") {
      if (apply) {
        await usage.setState(row.name, "stale");
      }
      counts.markedStale += 1;
    } else if (anchor > staleCutoff && row.state === "stale") {
      if (apply) {
        await usage.setState(row.name, "active");
      }
      counts.reactivated += 1;
    }
  }
  return counts;
}

async function archiveSkillFiles(io: SkillIo, name: string): Promise<void> {
  const dir = skillDirPath(name);
  if (await io.exists(dir)) {
    const archived = archivedSkillDirPath(name);
    if (await io.exists(archived)) {
      await io.remove(archived);
    }
    await io.move(dir, archived);
  } else if (await io.exists(flatSkillPath(name))) {
    await io.remove(flatSkillPath(name));
  }
}

export function formatTransitionSummary(counts: TransitionCounts): string {
  const parts: string[] = [];
  if (counts.markedStale) {
    parts.push(`${counts.markedStale} marked stale`);
  }
  if (counts.archived) {
    parts.push(`${counts.archived} archived`);
  }
  if (counts.reactivated) {
    parts.push(`${counts.reactivated} reactivated`);
  }
  return parts.length ? parts.join(", ") : "no lifecycle changes";
}

/** Candidate list given to the LLM consolidation pass. */
export function formatCandidateList(report: readonly SkillUsageReportRow[], nowMs: number): string {
  if (report.length === 0) {
    return "(no agent-created skills)";
  }
  return report
    .map((row) => {
      const last = parseIso(row.latestActivityAt);
      const ageDays = last ? Math.floor((nowMs - last) / DAY_MS) : null;
      const lastLabel = ageDays === null ? "never" : `${ageDays}d ago`;
      return `- ${row.name}  state=${row.state}  pinned=${row.pinned ? "yes" : "no"}  activity=${row.use_count + row.view_count + row.patch_count}  use=${row.use_count} view=${row.view_count} patches=${row.patch_count}  last_activity=${lastLabel}`;
    })
    .join("\n");
}

export interface CuratorSummary {
  readonly consolidations: readonly { readonly from: string; readonly into: string }[];
  readonly prunings: readonly { readonly name: string }[];
}

// Tolerant parse of the structured block the LLM is asked to emit. Best-effort — used for the report,
// not to drive the archiving (the LLM archives via skill_manage delete during the pass).
export function parseCuratorSummary(text: string): CuratorSummary {
  const consolidations: { from: string; into: string }[] = [];
  const prunings: { name: string }[] = [];
  const consolidationRe = /-\s*from:\s*([^\n]+)\n\s*into:\s*([^\n]+)/g;
  const pruningRe = /-\s*name:\s*([^\n]+)\n\s*reason:/g;
  let match: RegExpExecArray | null;
  while ((match = consolidationRe.exec(text))) {
    consolidations.push({ from: match[1].trim(), into: match[2].trim() });
  }
  while ((match = pruningRe.exec(text))) {
    prunings.push({ name: match[1].trim() });
  }
  return { consolidations, prunings };
}

export const CURATOR_REVIEW_PROMPT = [
  "You are running as CodeForge's background skill CURATOR. This is an UMBRELLA-BUILDING",
  "consolidation pass, not a passive audit and not a duplicate-finder.",
  "",
  "The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS AND EXPERIENTIAL",
  "KNOWLEDGE. A collection of hundreds of narrow skills where each captures one session's specific",
  "bug is a FAILURE of the library, not a feature. An agent searching skills matches on descriptions,",
  "not exact names; one broad umbrella skill with labeled subsections beats five narrow siblings for",
  "discoverability.",
  "",
  "Hard rules — do not violate:",
  "1. The candidate list below is already filtered to agent-created skills. Touch only those.",
  "2. DO NOT delete any skill. Archiving (skill_manage action=delete moves the skill into",
  "   .codeforge/skills/.archive/) is the maximum destructive action. Archives are recoverable.",
  "3. DO NOT touch skills shown as pinned=yes. Skip them entirely.",
  "4. DO NOT use usage counters as a reason to skip consolidation. The counters are new and often",
  "   mostly zero. Judge overlap on CONTENT, not on use_count.",
  "5. DO NOT reject consolidation because 'each skill has a distinct trigger'. The right bar is:",
  "   'would a maintainer write this as N separate skills, or one skill with N labeled subsections?'",
  "   When the answer is the latter, merge.",
  "",
  "How to work:",
  "1. Scan the full candidate list with skills_list / skill_view. Identify PREFIX CLUSTERS (skills",
  "   sharing a first word or domain keyword).",
  "2. For each cluster with 2+ members, find or create the UMBRELLA class skill and absorb the siblings.",
  "3. Three ways to consolidate — use the right one per cluster:",
  "   a. MERGE INTO EXISTING UMBRELLA: one member is already broad enough. skill_manage action=patch",
  "      it to add a labeled section for each sibling's unique insight, then archive the siblings.",
  "   b. CREATE A NEW UMBRELLA (skill_manage action=create) covering the shared workflow with short",
  "      labeled subsections; archive the absorbed narrow siblings.",
  "   c. DEMOTE TO A SUPPORT FILE (skill_manage action=write_file under references/, templates/, or",
  "      scripts/) when a sibling holds narrow-but-valuable detail; then archive the old sibling.",
  "4. To archive an absorbed/obsolete skill, call skill_manage action=delete with",
  "   absorbed_into=<umbrella> when merged, or absorbed_into=\"\" when pruned with no forwarding target.",
  "5. Iterate. After one consolidation round, scan for the next umbrella opportunity.",
  "",
  "'keep' is legitimate ONLY when a skill is already a class-level umbrella and no proposed merge would",
  "improve discoverability.",
  "",
  "When done, write a human summary AND a structured machine-readable block, formatted EXACTLY:",
  "",
  "## Structured summary (required)",
  "```yaml",
  "consolidations:",
  "  - from: <old-skill-name>",
  "    into: <umbrella-skill-name>",
  "    reason: <one short sentence>",
  "prunings:",
  "  - name: <skill-name>",
  "    reason: <one short sentence>",
  "```",
  "Every skill you archived MUST appear in exactly one list. Leave a list empty (consolidations: [])",
  "if none. Do not omit the block."
].join("\n");
