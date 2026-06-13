import test from "node:test";
import assert from "node:assert/strict";
import { NetworkPolicy } from "../../src/core/types";
import { McpToolBinding } from "../../src/core/toolDiscovery";
import { ToolRequestConfig, buildToolDefinitionsForRequest } from "../../src/agent/toolRequestDefinitions";

const config: ToolRequestConfig = {
  getMcpServers: () => [],
  getNetworkPolicy: () => ({ allowlist: [] }) as unknown as NetworkPolicy
};

test("ask mode returns read-only core tools and never write tools", async () => {
  const bindings = new Map<string, McpToolBinding>();
  const defs = await buildToolDefinitionsForRequest("ask", bindings, [], config, new AbortController().signal);
  const names = defs.map((definition) => definition.name);
  assert.ok(names.length > 0);
  assert.equal(names.includes("write_file"), false);
  assert.equal(names.includes("run_command"), false);
  assert.equal(bindings.size, 0);
});

test("agent mode with no MCP servers returns base tools without inspecting", async () => {
  const bindings = new Map<string, McpToolBinding>();
  const defs = await buildToolDefinitionsForRequest("agent", bindings, [], config, new AbortController().signal);
  assert.ok(defs.length > 0);
  assert.equal(bindings.size, 0);
});
