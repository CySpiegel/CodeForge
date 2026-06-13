import test from "node:test";
import assert from "node:assert/strict";
import { AgentAction, PermissionDecision } from "../../src/core/types";
import { WorkerSummary } from "../../src/core/workerTypes";
import { ApprovalMetadataConfig, buildApprovalMetadata, buildWorkerApprovalMetadata } from "../../src/agent/approvalMetadata";

const config: ApprovalMetadataConfig = {
  getMcpServers: () => [{ id: "srv", label: "Srv", transport: "http", url: "http://127.0.0.1:1/mcp" }],
  getCommandTimeoutSeconds: () => 120,
  getCommandOutputLimitBytes: () => 200000
};
const decision: PermissionDecision = { behavior: "ask", source: "mode", reason: "policy" };

function action(type: AgentAction["type"], extra: Record<string, unknown> = {}): AgentAction {
  return { type, ...extra } as unknown as AgentAction;
}

test("run_command metadata surfaces command, timeout, and a risk summary", () => {
  const meta = buildApprovalMetadata(action("run_command", { command: "npm test", cwd: "." }), decision, config);
  assert.match(meta.detail ?? "", /Command: npm test/);
  assert.match(meta.detail ?? "", /Timeout: 120s/);
  assert.match(meta.detail ?? "", /Permission: policy/);
  assert.ok((meta.risk ?? "").length > 0);
});

test("mcp_call_tool metadata names the server and tool", () => {
  const meta = buildApprovalMetadata(action("mcp_call_tool", { serverId: "srv", toolName: "do", arguments: {} }), decision, config);
  assert.match(meta.detail ?? "", /Server: srv \(Srv\)/);
  assert.match(meta.detail ?? "", /Tool: do/);
  assert.equal(meta.risk, "configured MCP service tool");
});

test("read-only actions produce empty metadata", () => {
  assert.deepEqual(buildApprovalMetadata(action("read_file", { path: "x" }), decision, config), {});
});

test("worker metadata wraps the base detail with worker identity", () => {
  const worker = { id: "worker-1-ab", label: "explore", prompt: "inspect x" } as unknown as WorkerSummary;
  const meta = buildWorkerApprovalMetadata(worker, action("run_command", { command: "ls", cwd: "." }), decision, config);
  assert.equal(meta.origin, "worker");
  assert.match(meta.detail ?? "", /Requested by worker: explore \(worker-1-ab\)/);
  assert.match(meta.detail ?? "", /Command: ls/);
});
