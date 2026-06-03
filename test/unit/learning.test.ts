import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEntry } from "../../src/core/memory";
import {
  buildLearningExtractionPrompt,
  formatLearnedDigest,
  isLearnedEntry,
  learnedLessonsFrom,
  lessonScopeFor,
  lessonStatusForAutonomy,
  normalizeLearningAutonomy,
  normalizeLearningScopeSetting,
  parseExtractionResult,
  parseLesson,
  plainMemoriesFrom,
  rankLessonsForPrompt,
  serializeLessonText
} from "../../src/core/learning";

function entry(text: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: "m1", text, createdAt: 1000, scope: "workspace", ...overrides };
}

test("serializeLessonText round-trips through parseLesson", () => {
  const text = serializeLessonText({
    kind: "fix",
    outcome: "failure",
    status: "proposed",
    paths: ["src/a.ts", "src/b.ts"],
    body: "Approval continuation must end in a tool result, not a user turn."
  });
  const lesson = parseLesson(entry(text, { id: "lesson-1", scope: "workspace", createdAt: 42 }));
  assert.ok(lesson);
  assert.equal(lesson.id, "lesson-1");
  assert.equal(lesson.kind, "fix");
  assert.equal(lesson.outcome, "failure");
  assert.equal(lesson.status, "proposed");
  assert.deepEqual(lesson.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(lesson.scope, "workspace");
  assert.equal(lesson.createdAt, 42);
  assert.match(lesson.body, /Approval continuation must end/);
});

test("parseLesson tolerates empty paths and rejects non-lessons", () => {
  const noPaths = parseLesson(entry(serializeLessonText({ kind: "fact", outcome: "success", status: "accepted", paths: [], body: "Uses node:test." })));
  assert.ok(noPaths);
  assert.deepEqual(noPaths.paths, []);
  assert.equal(parseLesson(entry("Just a normal user memory.")), undefined);
});

test("isLearnedEntry / partition helpers separate lessons from plain memories", () => {
  const lesson = entry(serializeLessonText({ kind: "preference", outcome: "success", status: "accepted", paths: [], body: "Prefers terse commits." }), { id: "l" });
  const plain = entry("Remember to bump the version before tagging.", { id: "p" });
  assert.equal(isLearnedEntry(lesson), true);
  assert.equal(isLearnedEntry(plain), false);
  assert.deepEqual(learnedLessonsFrom([lesson, plain]).map((l) => l.id), ["l"]);
  assert.deepEqual(plainMemoriesFrom([lesson, plain]).map((m) => m.id), ["p"]);
});

test("parseExtractionResult parses JSON, tolerates code fences, caps and validates", () => {
  const ok = parseExtractionResult("```json\n[{\"kind\":\"fix\",\"text\":\"root cause was X\",\"paths\":[\"a.ts\"]}]\n```");
  assert.equal(ok.length, 1);
  assert.equal(ok[0].kind, "fix");
  assert.deepEqual(ok[0].paths, ["a.ts"]);

  const capped = parseExtractionResult(JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ kind: "fact", text: `lesson ${i}` }))
  ));
  assert.equal(capped.length, 3);

  assert.deepEqual(parseExtractionResult("no json here"), []);
  assert.deepEqual(parseExtractionResult("{\"kind\":\"fix\"}"), []);
  assert.deepEqual(parseExtractionResult("[{\"kind\":\"bogus\",\"text\":\"x\"},{\"text\":\"\"}]"), []);
});

test("rankLessonsForPrompt ranks path overlap above stale recency", () => {
  const now = 1_000_000_000_000;
  const recentNoMatch = parseLesson(entry(serializeLessonText({ kind: "fact", outcome: "success", status: "accepted", paths: [], body: "unrelated detail" }), { id: "recent", createdAt: now }))!;
  const stalePathMatch = parseLesson(entry(serializeLessonText({ kind: "fix", outcome: "failure", status: "accepted", paths: ["src/agent/agentController.ts"], body: "watch the approval loop" }), { id: "stale", createdAt: now - 200 * 86_400_000 }))!;
  const ranked = rankLessonsForPrompt([recentNoMatch, stalePathMatch], {
    prompt: "fix the approval loop",
    changedPaths: ["src/agent/agentController.ts"],
    now
  });
  assert.equal(ranked[0].id, "stale");
});

test("formatLearnedDigest is byte-bounded and renders file hints", () => {
  const lessons = [
    parseLesson(entry(serializeLessonText({ kind: "fix", outcome: "failure", status: "accepted", paths: ["a.ts"], body: "first lesson" }), { id: "1" }))!,
    parseLesson(entry(serializeLessonText({ kind: "fact", outcome: "success", status: "accepted", paths: [], body: "second lesson body that is longer" }), { id: "2" }))!
  ];
  const full = formatLearnedDigest(lessons, 10_000);
  assert.match(full, /Lessons CodeForge learned/);
  assert.match(full, /\[fix\] first lesson \(files: a\.ts\)/);
  assert.match(full, /\[fact\] second lesson/);

  const header = "Lessons CodeForge learned from past work (apply when relevant):";
  const firstLine = "\n- [fix] first lesson (files: a.ts)";
  const tight = formatLearnedDigest(lessons, Buffer.byteLength(header + firstLine, "utf8"));
  assert.match(tight, /first lesson/);
  assert.doesNotMatch(tight, /second lesson/);

  assert.equal(formatLearnedDigest([], 10_000), "");
});

test("settings normalizers fall back to safe defaults", () => {
  assert.equal(normalizeLearningAutonomy("auto"), "auto");
  assert.equal(normalizeLearningAutonomy("nonsense"), "review");
  assert.equal(normalizeLearningScopeSetting("global"), "global");
  assert.equal(normalizeLearningScopeSetting(undefined), "split");
});

test("scope/status mapping follows configured autonomy and scope", () => {
  assert.equal(lessonScopeFor("preference", "split"), "user");
  assert.equal(lessonScopeFor("fix", "split"), "workspace");
  assert.equal(lessonScopeFor("fix", "global"), "user");
  assert.equal(lessonScopeFor("preference", "repo"), "workspace");
  assert.equal(lessonStatusForAutonomy("review"), "proposed");
  assert.equal(lessonStatusForAutonomy("hybrid"), "accepted");
  assert.equal(lessonStatusForAutonomy("auto"), "accepted");
});

test("extraction prompt steers corrective vs reusable by outcome", () => {
  const failure = buildLearningExtractionPrompt({ hadFailure: true, changedPaths: ["a.ts"], diagnostics: ["a.ts:1 error X"], commandFailures: [], outcomeSummary: "tests failed" });
  assert.match(failure.user, /CORRECTIVE/);
  assert.match(failure.user, /a\.ts:1 error X/);
  const success = buildLearningExtractionPrompt({ hadFailure: false, changedPaths: [], diagnostics: [], commandFailures: [], outcomeSummary: "done" });
  assert.match(success.user, /REUSABLE/);
});
