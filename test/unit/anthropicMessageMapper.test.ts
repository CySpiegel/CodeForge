import test from "node:test";
import assert from "node:assert/strict";
import { toAnthropicRequest, toAnthropicTool } from "../../src/core/anthropicMessageMapper";
import { ChatMessage } from "../../src/core/types";

test("hoists every system message out of the array into the top-level system param", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are CodeForge." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "system", content: "Compaction note." }, // re-injected mid-transcript
    { role: "user", content: "continue" }
  ];
  const parts = toAnthropicRequest(messages);
  assert.equal(parts.system, "You are CodeForge.\n\nCompaction note.");
  assert.ok(parts.messages.every((m) => m.role === "user" || m.role === "assistant"));
  assert.equal(parts.messages.length, 3);
  assert.equal(parts.messages[0].role, "user");
});

test("an assistant tool call becomes a tool_use block with PARSED object input", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }]
    },
    { role: "tool", toolCallId: "toolu_1", content: "file body", name: "read_file" }
  ];
  const parts = toAnthropicRequest(messages);
  const assistant = parts.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }
  ]);
});

test("consecutive tool results coalesce into one user message of tool_result blocks", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "do both" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_1", name: "a", argumentsJson: "{}" },
        { id: "toolu_2", name: "b", argumentsJson: "{}" }
      ]
    },
    { role: "tool", toolCallId: "toolu_1", content: "ra", name: "a" },
    { role: "tool", toolCallId: "toolu_2", content: "rb", name: "b" }
  ];
  const parts = toAnthropicRequest(messages);
  const resultsTurn = parts.messages[2];
  assert.equal(resultsTurn.role, "user");
  assert.deepEqual(resultsTurn.content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "ra" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "rb" }
  ]);
});

test("malformed tool-call arguments fall back to an empty object input (never the raw string)", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_1", name: "x", argumentsJson: '{"path":"a.ts' }] // truncated
    },
    { role: "tool", toolCallId: "toolu_1", content: "ok", name: "x" }
  ];
  const parts = toAnthropicRequest(messages);
  const block = (parts.messages[1].content as readonly { type: string; input?: unknown }[])[0];
  assert.equal(block.type, "tool_use");
  // recovered by parseToolArguments (closes the truncated string), so input is the repaired object
  assert.deepEqual(block.input, { path: "a.ts" });
});

test("an orphaned tool call (no result) gets a synthesized tool_result so pairing is valid", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "x", argumentsJson: "{}" }] }
    // no role:"tool" result follows
  ];
  const parts = toAnthropicRequest(messages);
  const last = parts.messages[parts.messages.length - 1];
  assert.equal(last.role, "user");
  const block = (last.content as readonly { type: string; tool_use_id: string }[])[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_1");
});

test("a leading non-user message gets a synthesized user turn prepended", () => {
  // After hoisting the only system message, the transcript would start with an assistant turn.
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: "resumed summary" }
  ];
  const parts = toAnthropicRequest(messages);
  assert.equal(parts.messages[0].role, "user");
  assert.equal(parts.messages[1].role, "assistant");
});

test("toAnthropicTool maps to {name, description, input_schema} and preserves an object schema", () => {
  const tool = toAnthropicTool({
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  });
  assert.deepEqual(tool, {
    name: "read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  });
  // a schema missing `type` is defaulted to an object schema
  assert.deepEqual(
    toAnthropicTool({ name: "n", description: "d", parameters: { properties: {} } }).input_schema,
    { type: "object", properties: {} }
  );
});

test("tools are only included when present", () => {
  assert.equal(toAnthropicRequest([{ role: "user", content: "hi" }]).tools, undefined);
  assert.ok(
    toAnthropicRequest([{ role: "user", content: "hi" }], [
      { name: "t", description: "d", parameters: { type: "object" } }
    ]).tools?.length === 1
  );
});
