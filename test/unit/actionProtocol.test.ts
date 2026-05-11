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
