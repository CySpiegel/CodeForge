import test from "node:test";
import assert from "node:assert/strict";
import { compactOldToolResults, compactToolResultContent } from "../../src/core/contextCompaction";

test("compacts old large tool results while preserving useful lines", () => {
  const largeOutput = [
    "run_command npm test",
    "",
    "Status: exited with 0",
    "STDOUT:",
    "src/core/context.ts:12: useful path",
    "x".repeat(9000)
  ].join("\n");

  const result = compactOldToolResults(
    [
      { role: "tool", content: largeOutput, toolCallId: "tool-1", name: "run_command" },
      { role: "assistant", content: "recent" }
    ],
    { maxBytes: 3000, keepRecentMessages: 0, minToolResultBytes: 1000 }
  );

  assert.equal(result.compactedCount, 1);
  assert.match(result.messages[0]?.content ?? "", /Status: exited with 0/);
  assert.match(result.messages[0]?.content ?? "", /src\/core\/context.ts:12/);
  assert.ok((result.messages[0]?.content.length ?? 0) < largeOutput.length);
});

test("keeps local tool result prefix when compacting fallback results", () => {
  const compacted = compactToolResultContent(`CodeForge local tool result:\n\nread_file src/a.ts\n\n${"x".repeat(5000)}`);

  assert.ok(compacted.startsWith("CodeForge local tool result:\n\n"));
  assert.match(compacted, /read_file src\/a.ts/);
});
