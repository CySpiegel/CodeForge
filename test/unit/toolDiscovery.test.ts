import test from "node:test";
import assert from "node:assert/strict";
import { ChatMessage } from "../../src/core/types";
import {
  codeForgeToolSchemaMarker,
  discoveredCodeForgeToolNames,
  discoveredMcpToolNames,
  McpToolBinding,
  mcpFunctionName,
  mcpToolParameters,
  mcpToolSchemaMarker,
  parseNativeToolCall,
  readOnlyToolNames,
  scoreToolSearch,
  searchCodeForgeTools,
  selectedToolNames,
  toolDefinitionsForAgentMode
} from "../../src/core/toolDiscovery";

test("selectedToolNames extracts select: directives", () => {
  assert.deepEqual([...selectedToolNames("load select:read_file,edit_file")], ["read_file", "edit_file"]);
  assert.deepEqual([...selectedToolNames("select:notebook_read")], ["notebook_read"]);
  assert.deepEqual([...selectedToolNames("no directive here")], []);
  // The directive char class includes whitespace, so trailing words after a select: are captured too.
  assert.deepEqual([...selectedToolNames("select:read_file extra")], ["read_file", "extra"]);
});

test("scoreToolSearch prioritizes explicit selection then name/term matches", () => {
  const selected = selectedToolNames("select:read_file");
  assert.equal(scoreToolSearch("select:read_file", selected, "read_file", "Read a file", []), 1000);
  assert.equal(scoreToolSearch("select:read_file", selected, "edit_file", "Edit a file", []), 0);

  const none = selectedToolNames("notebook");
  assert.equal(scoreToolSearch("notebook", none, "notebook_read", "Read a notebook", []), 45); // name includes term
  assert.equal(scoreToolSearch("notebook", none, "read_file", "Read a file", ["notebook hint"]), 15); // tag hit only
  assert.equal(scoreToolSearch("zzz", selectedToolNames("zzz"), "read_file", "Read", []), 0);
});

test("toolDefinitionsForAgentMode restricts read-only modes to read-only tools", () => {
  const agentTools = toolDefinitionsForAgentMode("agent").map((tool) => tool.name);
  const askTools = toolDefinitionsForAgentMode("ask").map((tool) => tool.name);
  assert.ok(agentTools.length > askTools.length);
  for (const name of askTools) {
    assert.ok(readOnlyToolNames.has(name), `${name} should be read-only`);
  }
  assert.deepEqual(toolDefinitionsForAgentMode("plan").map((tool) => tool.name), askTools);
});

test("searchCodeForgeTools only returns allowed, matching tools", () => {
  const allowed = new Set(["read_file", "edit_file"]);
  const results = searchCodeForgeTools("select:read_file", allowed);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "read_file");
  assert.ok(results[0].content.startsWith(codeForgeToolSchemaMarker));
  assert.equal(searchCodeForgeTools("select:notebook_read", allowed).length, 0);
});

test("mcpFunctionName produces stable, collision-free, bounded names", () => {
  const used = new Set<string>();
  // Hyphens are preserved by the name sanitizer; other punctuation (".") becomes "_".
  const first = mcpFunctionName("my-server", "do.thing", used);
  assert.equal(first, "mcp__my-server__do_thing");
  used.add(first);
  const second = mcpFunctionName("my-server", "do.thing", used);
  assert.notEqual(first, second);
  assert.ok(second.startsWith("mcp__my-server__do_thing"));
  assert.ok(mcpFunctionName("x".repeat(40), "y".repeat(80), new Set()).length <= 64);
});

test("discovered tool names parse schema-loaded markers from the transcript", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: `${codeForgeToolSchemaMarker} edit_file\nsome text ${codeForgeToolSchemaMarker} read_file` },
    { role: "assistant", content: `${mcpToolSchemaMarker} mcp__srv__tool` }
  ];
  assert.deepEqual([...discoveredCodeForgeToolNames(messages)].sort(), ["edit_file", "read_file"]);
  assert.deepEqual([...discoveredMcpToolNames(messages)], ["mcp__srv__tool"]);
});

test("mcpToolParameters passes object schemas through and defaults otherwise", () => {
  assert.deepEqual(mcpToolParameters({ type: "object", properties: {} }), { type: "object", properties: {} });
  assert.deepEqual(mcpToolParameters("nope"), { type: "object", additionalProperties: true });
  assert.deepEqual(mcpToolParameters({ type: "array" }), { type: "object", additionalProperties: true });
});

test("parseNativeToolCall resolves built-ins and falls back to MCP bindings", () => {
  const bindings = new Map<string, McpToolBinding>([["mcp__srv__tool", { serverId: "srv", toolName: "tool" }]]);

  const builtin = parseNativeToolCall({ id: "1", name: "read_file", argumentsJson: JSON.stringify({ path: "src/core/types.ts" }) }, bindings);
  assert.equal(builtin.ok, true);
  if (builtin.ok) {
    assert.equal(builtin.action.type, "read_file");
  }

  const mcp = parseNativeToolCall({ id: "2", name: "mcp__srv__tool", argumentsJson: JSON.stringify({ q: 1 }) }, bindings);
  assert.equal(mcp.ok, true);
  if (mcp.ok) {
    assert.deepEqual(mcp.action, {
      type: "mcp_call_tool",
      serverId: "srv",
      toolName: "tool",
      arguments: { q: 1 },
      reason: "Call MCP tool tool on srv"
    });
  }

  const badJson = parseNativeToolCall({ id: "3", name: "mcp__srv__tool", argumentsJson: "{not json" }, bindings);
  assert.equal(badJson.ok, false);

  const unknown = parseNativeToolCall({ id: "4", name: "totally_unknown_tool", argumentsJson: "{}" }, bindings);
  assert.equal(unknown.ok, false);
});
