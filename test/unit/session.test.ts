import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionSnapshot, SessionRecord } from "../../src/core/session";
import { ApprovalRequest } from "../../src/core/types";

test("builds snapshots with pending approvals", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    kind: "edit",
    title: "Write file",
    summary: "Write src/a.ts",
    action: { type: "write_file", path: "src/a.ts", content: "export const a = 1;\n" },
    createdAt: 3
  };
  const records: SessionRecord[] = [
    { type: "session_started", sessionId: "session-1", createdAt: 1, schemaVersion: 1, title: "CodeForge session" },
    { type: "message", sessionId: "session-1", createdAt: 2, message: { role: "user", content: "hello" } },
    { type: "approval_requested", sessionId: "session-1", createdAt: 3, approval }
  ];

  const snapshot = buildSessionSnapshot(records);

  assert.ok(snapshot);
  assert.equal(snapshot.messageCount, 1);
  assert.equal(snapshot.pendingApprovalCount, 1);
  assert.equal(snapshot.pendingApprovals[0]?.id, "approval-1");
});

test("resolved approvals are not pending on resume", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    kind: "command",
    title: "Run command",
    summary: "npm test",
    action: { type: "run_command", command: "npm test" },
    createdAt: 3
  };
  const snapshot = buildSessionSnapshot([
    { type: "session_started", sessionId: "session-1", createdAt: 1, schemaVersion: 1, title: "CodeForge session" },
    { type: "approval_requested", sessionId: "session-1", createdAt: 3, approval },
    { type: "approval_resolved", sessionId: "session-1", createdAt: 4, approvalId: "approval-1", accepted: true, text: "Accepted." }
  ]);

  assert.ok(snapshot);
  assert.equal(snapshot.pendingApprovalCount, 0);
  assert.equal(snapshot.pendingApprovals.length, 0);
});

test("message replacement records compact restored context", () => {
  const snapshot = buildSessionSnapshot([
    { type: "session_started", sessionId: "session-1", createdAt: 1, schemaVersion: 1, title: "CodeForge session" },
    { type: "message", sessionId: "session-1", createdAt: 2, message: { role: "user", content: "old prompt" } },
    {
      type: "messages_replaced",
      sessionId: "session-1",
      createdAt: 3,
      reason: "compact",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "Compacted session context:\n\nsummary" }
      ]
    },
    { type: "message", sessionId: "session-1", createdAt: 4, message: { role: "assistant", content: "next" } }
  ]);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.messages.map((message) => message.content), ["system", "Compacted session context:\n\nsummary", "next"]);
});
