import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, FAILED_RUN_CAUTION, MEMORY_REVIEW_PROMPT, normalizeLearningVerbosity, SKILL_REVIEW_PROMPT } from "../../src/core/backgroundReview";
import { learningNotices } from "../../src/agent/learningReview";

test("normalizeLearningVerbosity falls back to verbose for unknown values", () => {
  assert.equal(normalizeLearningVerbosity("concise"), "concise");
  assert.equal(normalizeLearningVerbosity("status"), "status");
  assert.equal(normalizeLearningVerbosity("silent"), "silent");
  assert.equal(normalizeLearningVerbosity("verbose"), "verbose");
  assert.equal(normalizeLearningVerbosity("nonsense"), "verbose");
  assert.equal(normalizeLearningVerbosity(undefined), "verbose");
});

test("learningNotices maps each verbosity to which notices surface", () => {
  assert.deepEqual(learningNotices("verbose"), { status: true, chat: true, emptyLine: true, failureLine: true });
  assert.deepEqual(learningNotices("concise"), { status: true, chat: true, emptyLine: false, failureLine: true });
  assert.deepEqual(learningNotices("status"), { status: true, chat: false, emptyLine: false, failureLine: false });
  assert.deepEqual(learningNotices("silent"), { status: false, chat: false, emptyLine: false, failureLine: false });
});

test("selects the memory review prompt", () => {
  const prompt = buildReviewPrompt(true, false);
  assert.equal(prompt, MEMORY_REVIEW_PROMPT);
  assert.match(prompt, /consider saving to memory/);
});

test("selects the skill review prompt", () => {
  const prompt = buildReviewPrompt(false, true);
  assert.equal(prompt, SKILL_REVIEW_PROMPT);
  assert.match(prompt, /update the skill library/);
});

test("combines both reviews when both cadences fire", () => {
  const prompt = buildReviewPrompt(true, true);
  assert.match(prompt, /## Memory review/);
  assert.match(prompt, /## Skill review/);
  assert.match(prompt, /consider saving to memory/);
  assert.match(prompt, /update the skill library/);
});

test("a successful run carries no failed-run caution", () => {
  assert.equal(buildReviewPrompt(true, true, "ok").includes(FAILED_RUN_CAUTION), false);
});

test("a failed run prepends the anti-poisoning caution that forbids skills and reusable lessons", () => {
  const prompt = buildReviewPrompt(true, false, "failed");
  assert.ok(prompt.startsWith(FAILED_RUN_CAUTION), "caution should lead the prompt");
  assert.match(prompt, /Do NOT create or patch skills/);
  assert.match(prompt, /reusable techniques/);
  // The underlying memory review is still present so persona facts / verified corrections can be saved.
  assert.match(prompt, /consider saving to memory/);
});
