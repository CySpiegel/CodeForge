import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionSnapshot } from "../../src/core/session";
import { normalizeSessionRecord } from "../../src/core/sessionMigration";

test("normalizes legacy session_started records to schema version 1", () => {
  const record = normalizeSessionRecord({
    type: "session_started",
    sessionId: "session-1",
    createdAt: 100,
    schemaVersion: 0,
    title: "Old session"
  });

  assert.deepEqual(record, {
    type: "session_started",
    sessionId: "session-1",
    createdAt: 100,
    schemaVersion: 1,
    title: "Old session"
  });
});

test("normalizes messages and tool calls into replayable session records", () => {
  const started = normalizeSessionRecord({
    type: "session_started",
    sessionId: "session-2",
    createdAt: 100,
    title: "Tool session"
  });
  const message = normalizeSessionRecord({
    type: "message",
    sessionId: "session-2",
    createdAt: 110,
    message: {
      role: "assistant",
      content: "Reading file.",
      toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }]
    }
  });

  assert.ok(started);
  assert.ok(message);
  const snapshot = buildSessionSnapshot([started, message]);
  assert.equal(snapshot?.messageCount, 1);
  assert.equal(snapshot?.messages[0].toolCalls?.[0].name, "read_file");
});

test("rejects corrupt or unsupported session records", () => {
  assert.equal(normalizeSessionRecord(undefined), undefined);
  assert.equal(normalizeSessionRecord({ type: "session_started", sessionId: "session-3", createdAt: 100 }), undefined);
  assert.equal(normalizeSessionRecord({
    type: "checkpoint",
    sessionId: "session-3",
    createdAt: 120,
    action: { type: "does_not_exist" },
    summary: "bad"
  }), undefined);
});
