import { MemoryEntry, MemoryScope, normalizeMemoryScope } from "./memory";

// CodeForge "learning over time" core (Hermes-style). Pure, dependency-free helpers:
// lesson (de)serialization over MemoryEntry, the extraction prompt + tolerant parser,
// relevance ranking, and the bounded digest used for context injection.

export type LessonKind = "fix" | "procedure" | "fact" | "preference";
export type LessonOutcome = "success" | "failure";
export type LessonStatus = "proposed" | "accepted";

export type LearningAutonomy = "review" | "hybrid" | "auto";
export type LearningScopeSetting = "split" | "repo" | "global";

export interface LearningSettings {
  readonly enabled: boolean;
  readonly autonomy: LearningAutonomy;
  readonly scope: LearningScopeSetting;
  readonly auditCadence: number;
  readonly maxLessons: number;
  readonly maxLessonBytes: number;
  readonly skillsEnabled: boolean;
  readonly skillsMinRepeats: number;
  readonly embeddingsEnabled: boolean;
}

export interface LearnedLesson {
  readonly id: string;
  readonly kind: LessonKind;
  readonly outcome: LessonOutcome;
  readonly status: LessonStatus;
  readonly paths: readonly string[];
  readonly body: string;
  readonly scope: MemoryScope;
  readonly createdAt: number;
}

export interface ProposedLesson {
  readonly kind: LessonKind;
  readonly text: string;
  readonly paths: readonly string[];
}

export interface LearningSignals {
  readonly hadFailure: boolean;
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly string[];
  readonly commandFailures: readonly string[];
  readonly outcomeSummary: string;
}

const TAG_PREFIX = "[codeforge-learned";
const MAX_LESSON_BODY = 600;
const MAX_LESSONS_PER_RUN = 3;

// --- Serialization over MemoryEntry.text --------------------------------------------------------
// Lessons are stored as ordinary MemoryEntry rows. All learning metadata lives in a single
// machine-parseable first line so no MemoryEntry schema change is required and the existing
// Memory UI / formatMemories keep working.

export function serializeLessonText(fields: {
  readonly kind: LessonKind;
  readonly outcome: LessonOutcome;
  readonly status: LessonStatus;
  readonly paths: readonly string[];
  readonly body: string;
}): string {
  const paths = fields.paths.map((path) => path.trim()).filter(Boolean).join(";");
  const tag = `${TAG_PREFIX} kind=${fields.kind} outcome=${fields.outcome} status=${fields.status} paths=${paths}]`;
  return `${tag}\n${fields.body.trim()}`;
}

export function parseLesson(entry: MemoryEntry): LearnedLesson | undefined {
  const newline = entry.text.indexOf("\n");
  const firstLine = (newline >= 0 ? entry.text.slice(0, newline) : entry.text).trim();
  const tag = parseTag(firstLine);
  if (!tag) {
    return undefined;
  }
  const body = newline >= 0 ? entry.text.slice(newline + 1).trim() : "";
  return {
    id: entry.id,
    kind: tag.kind,
    outcome: tag.outcome,
    status: tag.status,
    paths: tag.paths,
    body,
    scope: normalizeMemoryScope(entry.scope),
    createdAt: entry.createdAt
  };
}

export function isLearnedEntry(entry: MemoryEntry): boolean {
  return entry.text.trimStart().startsWith(`${TAG_PREFIX} `);
}

export function learnedLessonsFrom(entries: readonly MemoryEntry[]): readonly LearnedLesson[] {
  return entries.map(parseLesson).filter((lesson): lesson is LearnedLesson => Boolean(lesson));
}

export function plainMemoriesFrom(entries: readonly MemoryEntry[]): readonly MemoryEntry[] {
  return entries.filter((entry) => !isLearnedEntry(entry));
}

function parseTag(firstLine: string): { kind: LessonKind; outcome: LessonOutcome; status: LessonStatus; paths: readonly string[] } | undefined {
  const match = /^\[codeforge-learned (.*)\]$/.exec(firstLine);
  if (!match) {
    return undefined;
  }
  const inner = match[1];
  const kind = /(?:^| )kind=([a-z]+)/.exec(inner)?.[1];
  const outcome = /(?:^| )outcome=([a-z]+)/.exec(inner)?.[1];
  const status = /(?:^| )status=([a-z]+)/.exec(inner)?.[1];
  const pathsRaw = /(?:^| )paths=(.*)$/.exec(inner)?.[1] ?? "";
  if (!isLessonKind(kind) || !isLessonOutcome(outcome) || !isLessonStatus(status)) {
    return undefined;
  }
  const paths = pathsRaw.split(";").map((path) => path.trim()).filter(Boolean);
  return { kind, outcome, status, paths };
}

// --- Settings normalization ---------------------------------------------------------------------

export function normalizeLearningAutonomy(value: unknown): LearningAutonomy {
  return value === "hybrid" || value === "auto" ? value : "review";
}

export function normalizeLearningScopeSetting(value: unknown): LearningScopeSetting {
  return value === "repo" || value === "global" ? value : "split";
}

export function lessonScopeFor(kind: LessonKind, setting: LearningScopeSetting): MemoryScope {
  if (setting === "repo") {
    return "workspace";
  }
  if (setting === "global") {
    return "user";
  }
  return kind === "preference" ? "user" : "workspace";
}

export function lessonStatusForAutonomy(autonomy: LearningAutonomy): LessonStatus {
  // Lessons are low-risk text. They are only auto-committed under "auto" / "hybrid"; skills
  // (which write files) are gated separately. "review" keeps everything pending until accepted.
  return autonomy === "review" ? "proposed" : "accepted";
}

// --- Extraction prompt + tolerant parsing -------------------------------------------------------

export function buildLearningExtractionPrompt(signals: LearningSignals): { readonly system: string; readonly user: string } {
  const direction = signals.hadFailure
    ? "The task hit failures (see signals). Prefer CORRECTIVE lessons: the root cause and the concrete rule that avoids it next time."
    : "The task succeeded. Prefer REUSABLE lessons: durable facts about this codebase or repeatable procedures worth keeping.";
  const system = [
    "You distill durable, reusable engineering lessons from a finished CodeForge coding task so the agent improves over time.",
    "Output ONLY a JSON array (no prose, no code fences). Each item: {\"kind\":\"fix\"|\"procedure\"|\"fact\"|\"preference\",\"text\":string,\"paths\":string[]}.",
    "Rules: at most 3 items; each \"text\" under 280 characters; keep only lessons that will help on FUTURE tasks (not transient details, not restating the request).",
    "\"fix\"=a debugging insight/root cause; \"procedure\"=a repeatable multi-step workflow; \"fact\"=a durable fact about this repo; \"preference\"=a user/style preference.",
    "If nothing is worth remembering, output exactly []."
  ].join("\n");
  const user = [
    direction,
    "",
    `Outcome: ${signals.outcomeSummary || (signals.hadFailure ? "failed" : "succeeded")}`,
    signals.changedPaths.length ? `Changed files: ${signals.changedPaths.join(", ")}` : "Changed files: none",
    signals.diagnostics.length ? `Diagnostics after edits:\n${signals.diagnostics.map((line) => `- ${line}`).join("\n")}` : "",
    signals.commandFailures.length ? `Command failures:\n${signals.commandFailures.map((line) => `- ${line}`).join("\n")}` : "",
    "",
    "Return the JSON array of lessons now."
  ].filter(Boolean).join("\n");
  return { system, user };
}

export function parseExtractionResult(text: string): readonly ProposedLesson[] {
  const arrayText = extractJsonArray(text);
  if (!arrayText) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const lessons: ProposedLesson[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }
    const kind = item.kind;
    const body = typeof item.text === "string" ? item.text.trim() : "";
    if (!isLessonKind(kind) || !body) {
      continue;
    }
    const paths = Array.isArray(item.paths)
      ? item.paths.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean)
      : [];
    lessons.push({ kind, text: body.slice(0, MAX_LESSON_BODY), paths });
    if (lessons.length >= MAX_LESSONS_PER_RUN) {
      break;
    }
  }
  return lessons;
}

function extractJsonArray(text: string): string | undefined {
  const withoutFences = text.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return withoutFences.slice(start, end + 1);
}

// --- Retrieval ranking + digest -----------------------------------------------------------------

export interface RankOptions {
  readonly prompt: string;
  readonly changedPaths?: readonly string[];
  readonly pinnedFiles?: readonly string[];
  readonly now?: number;
}

export function rankLessonsForPrompt(lessons: readonly LearnedLesson[], options: RankOptions): readonly LearnedLesson[] {
  const now = options.now ?? Date.now();
  const focusPaths = new Set(
    [...(options.changedPaths ?? []), ...(options.pinnedFiles ?? []), ...extractPathTokens(options.prompt)].map(normalizePathToken)
  );
  const promptTokens = tokenize(options.prompt);
  return [...lessons]
    .map((lesson, index) => ({ lesson, index, score: scoreLesson(lesson, focusPaths, promptTokens, now) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.lesson);
}

function scoreLesson(lesson: LearnedLesson, focusPaths: Set<string>, promptTokens: Set<string>, now: number): number {
  const pathOverlap = lesson.paths.reduce((count, path) => count + (focusPaths.has(normalizePathToken(path)) ? 1 : 0), 0);
  const lessonTokens = tokenize(lesson.body);
  let keywordOverlap = 0;
  for (const token of lessonTokens) {
    if (promptTokens.has(token)) {
      keywordOverlap += 1;
    }
  }
  const ageDays = Math.max(0, (now - lesson.createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 30);
  const kindBonus = lesson.kind === "preference" ? 1.5 : lesson.kind === "fix" ? 0.5 : 0;
  return pathOverlap * 3 + Math.min(keywordOverlap, 6) * 1 + recency * 2 + kindBonus;
}

export function formatLearnedDigest(lessons: readonly LearnedLesson[], maxBytes: number): string {
  if (lessons.length === 0 || maxBytes <= 0) {
    return "";
  }
  const header = "Lessons CodeForge learned from past work (apply when relevant):";
  const lines: string[] = [header];
  let used = Buffer.byteLength(header, "utf8");
  for (const lesson of lessons) {
    const filesSuffix = lesson.paths.length ? ` (files: ${lesson.paths.join(", ")})` : "";
    const line = `- [${lesson.kind}] ${lesson.body}${filesSuffix}`;
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
    if (used + lineBytes > maxBytes) {
      break;
    }
    lines.push(line);
    used += lineBytes;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// --- token helpers ------------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length > 3) {
      tokens.add(raw);
    }
  }
  return tokens;
}

function extractPathTokens(text: string): readonly string[] {
  return text.match(/[\w./-]+\.[a-z0-9]{1,6}/gi) ?? [];
}

function normalizePathToken(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function isLessonKind(value: unknown): value is LessonKind {
  return value === "fix" || value === "procedure" || value === "fact" || value === "preference";
}

function isLessonOutcome(value: unknown): value is LessonOutcome {
  return value === "success" || value === "failure";
}

function isLessonStatus(value: unknown): value is LessonStatus {
  return value === "proposed" || value === "accepted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
