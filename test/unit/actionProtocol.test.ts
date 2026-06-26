import test from "node:test";
import assert from "node:assert/strict";
import { parseActionsFromAssistantText, parseToolAction, parseToolActionDetailed } from "../../src/core/actionProtocol";

test("parses fenced JSON action envelopes", () => {
  const actions = parseActionsFromAssistantText(`
Here is the action:

\`\`\`json
{
  "actions": [
    { "type": "read_file", "path": "src/index.ts", "reason": "inspect" },
    { "type": "run_command", "command": "npm test", "cwd": "." }
  ]
}
\`\`\`
`);

  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], { type: "read_file", path: "src/index.ts", reason: "inspect" });
  assert.deepEqual(actions[1], { type: "run_command", command: "npm test", cwd: ".", reason: undefined });
});

test("parses native tool call arguments into actions", () => {
  const action = parseToolAction("search_text", "{\"query\":\"AgentController\",\"reason\":\"find code\"}");
  assert.deepEqual(action, { type: "search_text", query: "AgentController", reason: "find code" });
});

test("reports native tool call parse errors", () => {
  const invalidJson = parseToolActionDetailed("read_file", "{\"path\":");
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.ok ? "" : invalidJson.message, /valid JSON/);

  const missingRequired = parseToolActionDetailed("read_file", "{\"path\":123}");
  assert.equal(missingRequired.ok, false);
  assert.match(missingRequired.ok ? "" : missingRequired.message, /missing required parameters/);
});

test("recovers a read_file tool call truncated mid-path instead of hard-failing", () => {
  // The reported failure: the endpoint streamed a read_file call whose path string was cut off, so a
  // bare JSON.parse threw "Unterminated string". The inbound parser now repairs it and executes.
  const recovered = parseToolActionDetailed("read_file", "{\"path\":\"src/core/openaiAd");
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.ok ? recovered.action : null, { type: "read_file", path: "src/core/openaiAd", reason: undefined });
});

test("recovers the required field when a trailing argument is truncated", () => {
  const recovered = parseToolActionDetailed("read_file", "{\"path\":\"src/index.ts\",\"reason\":\"insp");
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.ok ? recovered.action : null, { type: "read_file", path: "src/index.ts", reason: "insp" });
});

test("returns a retryable instruction when truncated arguments cannot be recovered", () => {
  const failed = parseToolActionDetailed("read_file", "{\"path\":");
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.message, /Re-issue the read_file call/);
  assert.match(failed.ok ? "" : failed.message, /valid JSON/);
});

test("recovers a truncated JSON action-protocol envelope (non-native model path)", () => {
  // A text-protocol model emitted {"actions":[...]} but got cut off mid-string with no closing brace.
  // Previously this produced no candidate and silently zero actions; now it is repaired and runs.
  const actions = parseActionsFromAssistantText("{\"actions\":[{\"type\":\"read_file\",\"path\":\"src/index.ts\",\"reason\":\"insp");
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { type: "read_file", path: "src/index.ts", reason: "insp" });
});
