import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, MEMORY_REVIEW_PROMPT, SKILL_REVIEW_PROMPT } from "../../src/core/backgroundReview";

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
