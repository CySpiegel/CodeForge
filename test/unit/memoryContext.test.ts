import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryContextBlock,
  MEMORY_CONTEXT_CLOSE,
  MEMORY_CONTEXT_OPEN,
  StreamingContextScrubber
} from "../../src/core/memoryContext";

test("wraps recalled memory in fences with a system note", () => {
  const block = buildMemoryContextBlock("recalled fact A");
  assert.ok(block.startsWith(MEMORY_CONTEXT_OPEN));
  assert.ok(block.trimEnd().endsWith(MEMORY_CONTEXT_CLOSE));
  assert.match(block, /System note:/);
  assert.match(block, /recalled fact A/);
});

test("empty recall yields no block, and embedded fences are stripped", () => {
  assert.equal(buildMemoryContextBlock("   "), "");
  const block = buildMemoryContextBlock(`${MEMORY_CONTEXT_OPEN}sneaky${MEMORY_CONTEXT_CLOSE}`);
  // Only the outer wrapper fences should remain (one open, one close).
  assert.equal(block.split(MEMORY_CONTEXT_OPEN).length - 1, 1);
  assert.equal(block.split(MEMORY_CONTEXT_CLOSE).length - 1, 1);
  assert.match(block, /sneaky/);
});

test("scrubber removes a whole span and keeps surrounding text", () => {
  const s = new StreamingContextScrubber();
  const out = s.feed(`hello ${MEMORY_CONTEXT_OPEN}secret${MEMORY_CONTEXT_CLOSE} world`) + s.flush();
  assert.equal(out, "hello  world");
});

test("scrubber survives a tag split across chunks", () => {
  const s = new StreamingContextScrubber();
  let out = "";
  out += s.feed("visible <memory-");
  out += s.feed("context>hidden</memory-");
  out += s.feed("context>tail");
  out += s.flush();
  assert.equal(out, "visible tail");
});

test("scrubber drops an unterminated span on flush", () => {
  const s = new StreamingContextScrubber();
  let out = s.feed(`keep ${MEMORY_CONTEXT_OPEN}dangling content`);
  out += s.flush();
  assert.equal(out, "keep ");
});

test("scrubber passes through ordinary text unchanged", () => {
  const s = new StreamingContextScrubber();
  const out = s.feed("just a normal < answer > with angle brackets") + s.flush();
  assert.equal(out, "just a normal < answer > with angle brackets");
});
