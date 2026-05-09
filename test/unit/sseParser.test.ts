import test from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../../src/core/sseParser";

test("parses complete and split SSE events", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"a\":"), []);
  assert.deepEqual(parser.push("1}\n\n"), [{ data: "{\"a\":1}", event: undefined }]);
});

test("joins multiline data fields", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: message\ndata: one\ndata: two\n\n"), [{ event: "message", data: "one\ntwo" }]);
});
