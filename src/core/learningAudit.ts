import { LearnedLesson } from "./learning";

// Hermes-style periodic self-audit ("nudge"): the model reviews the learned-lesson corpus and
// proposes which to drop (duplicates / outdated / low value) and which to rewrite more sharply.
// The controller additionally enforces a hard count cap deterministically.

export interface AuditPlan {
  readonly drop: readonly number[];
  readonly rewrite: readonly { readonly index: number; readonly text: string }[];
}

export function buildAuditPrompt(lessons: readonly LearnedLesson[], maxLessons: number): { readonly system: string; readonly user: string } {
  const system = [
    "You audit an AI coding agent's library of learned lessons and prune it so only the most useful, non-redundant lessons remain.",
    "Output ONLY a JSON object (no prose, no code fences): {\"drop\":[<1-based indices to delete>],\"rewrite\":[{\"i\":<index>,\"text\":\"sharper wording\"}]}.",
    `Aim to keep at most ${maxLessons} lessons. Drop duplicates, outdated, contradicted, or vague lessons. Rewrite only when a lesson can be made clearly more reusable. Be conservative and never invent indices.`
  ].join("\n");
  const user = [
    "Current learned lessons:",
    ...lessons.map((lesson, index) => `${index + 1}. [${lesson.kind}/${lesson.outcome}] ${lesson.body}${lesson.paths.length ? ` (files: ${lesson.paths.join(", ")})` : ""}`),
    "",
    "Return the audit JSON now."
  ].join("\n");
  return { system, user };
}

export function parseAuditPlan(text: string, lessonCount: number): AuditPlan {
  const objectText = extractJsonObject(text);
  if (!objectText) {
    return { drop: [], rewrite: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return { drop: [], rewrite: [] };
  }
  if (!isRecord(parsed)) {
    return { drop: [], rewrite: [] };
  }
  const drop = new Set<number>();
  if (Array.isArray(parsed.drop)) {
    for (const value of parsed.drop) {
      const index = toIndex(value, lessonCount);
      if (index !== undefined) {
        drop.add(index);
      }
    }
  }
  const rewrite: { index: number; text: string }[] = [];
  if (Array.isArray(parsed.rewrite)) {
    for (const item of parsed.rewrite) {
      if (!isRecord(item)) {
        continue;
      }
      const index = toIndex(item.i ?? item.index, lessonCount);
      const newText = typeof item.text === "string" ? item.text.trim() : "";
      if (index !== undefined && newText && !drop.has(index)) {
        rewrite.push({ index, text: newText.slice(0, 600) });
      }
    }
  }
  return { drop: [...drop], rewrite };
}

// Deterministically choose the lessons to evict to satisfy a hard count cap, after the model's
// plan is applied. Oldest lessons are evicted first.
export function overflowEvictions(lessons: readonly LearnedLesson[], maxLessons: number): readonly string[] {
  if (lessons.length <= maxLessons) {
    return [];
  }
  return [...lessons]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, lessons.length - maxLessons)
    .map((lesson) => lesson.id);
}

function toIndex(value: unknown, lessonCount: number): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= lessonCount ? parsed : undefined;
}

function extractJsonObject(text: string): string | undefined {
  const withoutFences = text.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return withoutFences.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
