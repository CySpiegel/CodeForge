import test from "node:test";
import assert from "node:assert/strict";
import { AgentUiEvent } from "../../src/agent/agentController";
import { createControllerHarness, toolCall, waitForEvent } from "../harness/agentControllerHarness";

test("/doctor runs diagnostics without consuming a chat completion", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: []
  });

  await harness.controller.sendPrompt("/doctor");

  const report = harness.events.find((event) => event.type === "message" && event.role === "system" && event.text.startsWith("CodeForge Doctor:"));
  assert.ok(report && report.type === "message");
  assert.match(report.text, /Endpoint\n\[pass\] Network policy:/);
  assert.match(report.text, /\[pass\] Model discovery: 1 model\(s\) returned by \/v1\/models\./);
  assert.match(report.text, /Repo Folder\n\[pass\] File discovery:/);
  assert.match(report.text, /Permissions\n\[pass\] Approval mode:/);
  assert.match(report.text, /Tooling\n\[pass\] Internal tools:/);
  assert.equal(harness.provider.requests.length, 0);
});

test("Ask mode executes read-only workspace tools and continues with tool results", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: [
      { toolCalls: [toolCall("list_files", { limit: 10 })] },
      { content: "Found README.md and src/index.ts." }
    ]
  });

  await harness.controller.sendPrompt("List the workspace files.");

  assertToolCompleted(harness.events, "list_files");
  assert.equal(harness.provider.requests.length, 2);
  assertToolWasOffered(harness.provider.requests[0].tools, "list_files");
  assertToolWasNotOffered(harness.provider.requests[0].tools, "write_file");
  assertAssistantMessage(harness.events, /Found README\.md and src\/index\.ts/);
});

test("Plan mode can load deferred code-intel schemas through tool_search", async () => {
  const harness = createControllerHarness({
    mode: "plan",
    files: {
      "src/index.ts": "export function add(a: number, b: number) { return a + b; }\n"
    },
    responses: [
      { toolCalls: [toolCall("tool_search", { query: "select:code_symbols" })] },
      { toolCalls: [toolCall("code_symbols", { path: "src/index.ts" })] },
      { content: "Plan: inspect symbols, then update callers if needed." }
    ]
  });

  await harness.controller.sendPrompt("Use code symbols and produce a short plan.");

  assertToolCompleted(harness.events, "tool_search");
  assertToolCompleted(harness.events, "code_symbols");
  assert.equal(harness.codeIntel.actions.length, 1);
  assertToolWasNotOffered(harness.provider.requests[0].tools, "code_symbols");
  assertToolWasOffered(harness.provider.requests[1].tools, "code_symbols");
});

test("Ask and Plan modes reject side-effect tools before execution", async () => {
  for (const mode of ["ask", "plan"] as const) {
    const harness = createControllerHarness({
      mode,
      files: { "README.md": "# CodeForge\n" },
      responses: [
        { toolCalls: [toolCall("write_file", { path: "NEW.md", content: "nope" })] },
        { content: "I cannot write in this mode." }
      ]
    });

    await harness.controller.sendPrompt("Try to write a file.");

    assertToolFailed(harness.events, "write_file");
    assert.equal(harness.diff.writes.length, 0);
    assert.equal(harness.workspace.files.has("NEW.md"), false);
  }
});

test("Agent mode executes write_file in full auto through the diff pipeline", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "SMOKE_AGENT.md", content: "Agent mode wrote this file." })] },
      { content: "Created SMOKE_AGENT.md." }
    ]
  });

  await harness.controller.sendPrompt("Create SMOKE_AGENT.md.");

  assertToolCompleted(harness.events, "write_file");
  assert.equal(harness.diff.writes.length, 1);
  assert.equal(harness.workspace.files.get("SMOKE_AGENT.md"), "Agent mode wrote this file.");
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /Verification:\n- No VS Code errors or warnings/.test(event.text)));
  assertAssistantMessage(harness.events, /Created SMOKE_AGENT\.md/);
});

test("Agent mode executes edit_file in full auto through the diff pipeline", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "README.md": "# CodeForge\nold value\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "README.md" }),
          toolCall("edit_file", { path: "README.md", oldText: "old value", newText: "new value" })
        ]
      },
      { content: "Edited README.md." }
    ]
  });

  await harness.controller.sendPrompt("Edit README.md.");

  assertToolCompleted(harness.events, "edit_file");
  assert.equal(harness.diff.edits.length, 1);
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nnew value\n");
  assertAssistantMessage(harness.events, /Edited README\.md/);
});

test("Agent mode applies propose_patch in full auto through the diff pipeline", async () => {
  const patch = `--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "src/value.ts": "export const value = 1;\n" },
    responses: [
      { toolCalls: [toolCall("propose_patch", { patch })] },
      { content: "Patched src/value.ts." }
    ]
  });

  await harness.controller.sendPrompt("Patch src/value.ts.");

  assertToolCompleted(harness.events, "propose_patch");
  assert.equal(harness.diff.patches.length, 1);
  assert.equal(harness.workspace.files.get("src/value.ts"), "export const value = 2;\n");
  assertAssistantMessage(harness.events, /Patched src\/value\.ts/);
});

test("Full auto edit failures return tool errors and keep the model loop alive", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "README.md": "# CodeForge\nold value\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "README.md" }),
          toolCall("edit_file", { path: "README.md", oldText: "missing value", newText: "new value" })
        ]
      },
      { content: "I will retry after reading the current file." }
    ]
  });

  await harness.controller.sendPrompt("Edit README.md.");

  assertToolFailed(harness.events, "edit_file");
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nold value\n");
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /oldText was not found/.test(event.text)));
  assertAssistantMessage(harness.events, /retry after reading/);
});

test("pinned active files are attached to future prompt context", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "src/pinned.ts": "export const pinned = true;\n",
      "src/other.ts": "export const other = true;\n"
    },
    responses: [{ content: "Pinned context checked." }]
  });
  harness.workspace.activeDocument = { kind: "activeFile", label: "src/pinned.ts", content: "export const pinned = true;\n" };

  await harness.controller.sendPrompt("/pin");
  await harness.controller.sendPrompt("What file is pinned?");

  const contextMessage = harness.provider.requests[0].messages.find((message) => message.content.startsWith("CodeForge workspace context:"));
  assert.match(contextMessage?.content ?? "", /### file: Pinned: src\/pinned\.ts/);
  assert.ok(harness.events.some((event) => event.type === "state" && event.state.activeContext.pinnedFiles.includes("src/pinned.ts")));
});

test("manual context compaction queues prompts instead of leaving the chat blocked", async () => {
  let releaseCompact: () => void = () => undefined;
  const compactGate = new Promise<void>((resolve) => {
    releaseCompact = resolve;
  });
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { content: "Seed response." },
      { content: "Compacted summary.", waitBeforeDone: compactGate },
      { content: "Queued prompt completed." }
    ]
  });

  await harness.controller.sendPrompt("Seed the session.");
  const compactPromise = harness.controller.compactContext();
  await waitForEvent(harness.events, (event) => event.type === "status" && /Compacting context/.test(event.text));

  await harness.controller.sendPrompt("Run after compact.");
  assert.ok(harness.events.some((event) => event.type === "status" && /Queued prompt/.test(event.text)));
  assert.equal(harness.provider.requests.length, 2);
  assert.equal(harness.events.some((event) => event.type === "error" && /already running|Wait for the current request/.test(event.text)), false);

  releaseCompact();
  await compactPromise;
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Queued prompt completed/.test(event.text));

  assert.equal(harness.provider.requests.length, 3);
});

test("manual context compaction idle timeout releases the running slot", async () => {
  const previousTimeout = process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS;
  process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS = "25";
  try {
    const harness = createControllerHarness({
      mode: "ask",
      files: { "README.md": "# CodeForge\n" },
      responses: [
        { content: "Seed response." },
        { content: "Partial compact.", waitBeforeDone: new Promise<void>(() => undefined) },
        { content: "Recovered after timeout." }
      ]
    });

    await harness.controller.sendPrompt("Seed the session.");
    await harness.controller.compactContext();
    assert.ok(harness.events.some((event) => event.type === "error" && /Context compaction timed out/.test(event.text)));

    await harness.controller.sendPrompt("Can you still answer?");
    await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Recovered after timeout/.test(event.text));
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS;
    } else {
      process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("inspector and audit track denied side-effect tools", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "NEW.md", content: "nope" })] },
      { content: "Denied as expected." }
    ]
  });

  await harness.controller.sendPrompt("Try to write.");

  const inspector = [...harness.events].reverse().find((event) => event.type === "inspector");
  assert.ok(inspector && inspector.type === "inspector");
  assert.ok(inspector.inspector.audit.some((entry) => entry.action === "write_file" && entry.outcome === "denied"));
  await harness.controller.sendPrompt("/audit");
  assert.ok(harness.events.some((event) => event.type === "message" && event.role === "system" && /Permission audit:/.test(event.text)));
});

test("controller memory APIs support add, edit, and remove", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: []
  });

  await harness.controller.addMemory("Prefer focused tests.", "workspace");
  const [memory] = await harness.memory.list();
  assert.equal(memory.text, "Prefer focused tests.");

  await harness.controller.updateMemory(memory.id, "Prefer narrow tests.", "user");
  const [updated] = await harness.memory.list();
  assert.equal(updated.text, "Prefer narrow tests.");
  assert.equal(updated.scope, "user");

  await harness.controller.removeMemory(updated.id);
  assert.equal((await harness.memory.list()).length, 0);
});

test("Manual approval pauses side effects, then approve resumes the model loop", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "APPROVED.md", content: "approved" })] },
      { content: "Approved write completed." }
    ]
  });

  await harness.controller.sendPrompt("Create APPROVED.md.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");
  assert.equal(approval.approval.action.type, "write_file");
  assert.equal(harness.diff.writes.length, 0);

  await harness.controller.approve(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Approved write completed/.test(event.text));

  assert.ok(harness.events.some((event) => event.type === "toolUse" && event.toolUse.name === "write_file" && event.toolUse.status === "running"));
  assert.ok(harness.events.some((event) => event.type === "toolUse" && event.toolUse.name === "write_file" && event.toolUse.status === "completed"));
  assert.equal(harness.diff.writes.length, 1);
  assert.equal(harness.workspace.files.get("APPROVED.md"), "approved");
});

test("Smart approval asks before applying file edits in Agent mode", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "smart",
    files: { "README.md": "# CodeForge\nold\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "README.md" }),
          toolCall("edit_file", { path: "README.md", oldText: "old", newText: "new" })
        ]
      },
      { content: "Smart-approved edit completed." }
    ]
  });

  await harness.controller.sendPrompt("Edit README.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");
  assert.equal(approval.approval.action.type, "edit_file");
  assert.equal(harness.diff.edits.length, 0);
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nold\n");

  await harness.controller.approve(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Smart-approved edit completed/.test(event.text));

  assert.ok(harness.events.some((event) => event.type === "toolUse" && event.toolUse.name === "edit_file" && event.toolUse.status === "running"));
  assert.ok(harness.events.some((event) => event.type === "toolUse" && event.toolUse.name === "edit_file" && event.toolUse.status === "completed"));
  assert.equal(harness.diff.edits.length, 1);
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nnew\n");
});

test("Existing file edits must read the file before approval", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "smart",
    files: { "README.md": "# CodeForge\nold\n" },
    responses: [
      { toolCalls: [toolCall("edit_file", { path: "README.md", oldText: "old", newText: "new" })] },
      { content: "I will read README.md before editing it." }
    ]
  });

  await harness.controller.sendPrompt("Edit README.");

  assert.equal(harness.events.some((event) => event.type === "approvalRequested"), false);
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /requires reading README\.md/.test(event.text)));
  assert.equal(harness.diff.edits.length, 0);
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nold\n");
  assertAssistantMessage(harness.events, /read README\.md before editing/);
});

test("Edit preflight recovery can read the file and then request approval", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "smart",
    files: { "README.md": "# CodeForge\nold\n" },
    responses: [
      { toolCalls: [toolCall("edit_file", { path: "README.md", oldText: "old", newText: "new" }, "call-bad-edit")] },
      { toolCalls: [toolCall("read_file", { path: "README.md" }, "call-read")] },
      { toolCalls: [toolCall("edit_file", { path: "README.md", oldText: "old", newText: "new" }, "call-good-edit")] },
      { content: "Recovered and finished the edit." }
    ]
  });

  await harness.controller.sendPrompt("Edit README.");
  const approval = harness.events.find((event): event is Extract<AgentUiEvent, { readonly type: "approvalRequested" }> =>
    event.type === "approvalRequested"
  );

  assert.ok(approval);
  assert.equal(approval.approval.toolCallId, "call-good-edit");
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /requires reading README\.md/.test(event.text)));
  assertToolCompleted(harness.events, "read_file");

  await harness.controller.approve(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Recovered and finished/.test(event.text));

  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nnew\n");
});

test("Invalid edit preflight returns a tool error instead of asking approval for a doomed edit", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "smart",
    files: { "src/current.ts": "export const value = 1;\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "src/current.ts" }),
          toolCall("edit_file", { path: "src/current.ts", oldText: "export const missing = 1;", newText: "export const value = 2;" })
        ]
      },
      { content: "I will read the current file and retry with exact text." }
    ]
  });

  await harness.controller.sendPrompt("Update src/current.ts.");

  assert.equal(harness.events.some((event) => event.type === "approvalRequested"), false);
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /oldText was not found/.test(event.text)));
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /Current file excerpts/.test(event.text)));
  assertAssistantMessage(harness.events, /read the current file and retry/);
  assert.equal(harness.diff.edits.length, 0);
  assert.equal(harness.workspace.files.get("src/current.ts"), "export const value = 1;\n");
});

test("Approved edits continue into the next planned tool request", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n"
    },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "src/a.ts" }, "call-read-a"),
          toolCall("edit_file", { path: "src/a.ts", oldText: "1", newText: "2" }, "call-edit-a")
        ]
      },
      {
        toolCalls: [
          toolCall("read_file", { path: "src/b.ts" }, "call-read-b"),
          toolCall("edit_file", { path: "src/b.ts", oldText: "1", newText: "2" }, "call-edit-b")
        ]
      },
      { content: "Both planned edits are complete." }
    ]
  });

  const firstApprovalSeen = new Promise<Extract<AgentUiEvent, { readonly type: "approvalRequested" }>>((resolve) => {
    const dispose = harness.controller.onEvent((event) => {
      if (event.type === "approvalRequested") {
        dispose();
        resolve(event);
      }
    });
  });
  const promptRun = harness.controller.sendPrompt("Update both files.");
  const firstApproval = await firstApprovalSeen;
  assert.equal(firstApproval.approval.action.type, "edit_file");
  assert.equal(firstApproval.approval.action.path, "src/a.ts");

  await harness.controller.approve(firstApproval.approval.id);
  await promptRun;
  await waitForEvent(harness.events, (event) =>
    event.type === "approvalRequested"
    && event.approval.id !== firstApproval.approval.id
  );
  const secondApproval = harness.events
    .filter((event): event is Extract<AgentUiEvent, { readonly type: "approvalRequested" }> => event.type === "approvalRequested")
    .find((event) => event.approval.id !== firstApproval.approval.id);
  assert.ok(secondApproval);
  assert.equal(secondApproval.approval.action.type, "edit_file");
  assert.equal(secondApproval.approval.action.path, "src/b.ts");
  assert.ok(harness.provider.requests[1]?.messages.some((message) => /CodeForge continuation: The user approved/.test(message.content)));

  await harness.controller.approve(secondApproval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Both planned edits/.test(event.text));

  assert.equal(harness.workspace.files.get("src/a.ts"), "export const a = 2;\n");
  assert.equal(harness.workspace.files.get("src/b.ts"), "export const b = 2;\n");
});

test("Approved edit continues queued tool calls from the same model turn before requesting the model again", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n"
    },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "src/a.ts" }, "call-read-a"),
          toolCall("edit_file", { path: "src/a.ts", oldText: "1", newText: "2" }, "call-edit-a"),
          toolCall("read_file", { path: "src/b.ts" }, "call-read-b"),
          toolCall("edit_file", { path: "src/b.ts", oldText: "1", newText: "2" }, "call-edit-b")
        ]
      },
      { content: "Both same-turn edits are complete." }
    ]
  });

  const firstApprovalSeen = new Promise<Extract<AgentUiEvent, { readonly type: "approvalRequested" }>>((resolve) => {
    const dispose = harness.controller.onEvent((event) => {
      if (event.type === "approvalRequested") {
        dispose();
        resolve(event);
      }
    });
  });
  const promptRun = harness.controller.sendPrompt("Update both files in one turn.");
  const firstApproval = await firstApprovalSeen;
  assert.equal(firstApproval.approval.action.type, "edit_file");
  assert.equal(firstApproval.approval.action.path, "src/a.ts");
  await promptRun;

  const secondApprovalSeen = new Promise<Extract<AgentUiEvent, { readonly type: "approvalRequested" }>>((resolve) => {
    const dispose = harness.controller.onEvent((event) => {
      if (event.type === "approvalRequested" && event.approval.id !== firstApproval.approval.id) {
        dispose();
        resolve(event);
      }
    });
  });
  await harness.controller.approve(firstApproval.approval.id);
  const secondApproval = await Promise.race([
    secondApprovalSeen,
    new Promise<never>((_, reject) => setTimeout(() => {
      const approvals = harness.events
        .filter((event): event is Extract<AgentUiEvent, { readonly type: "approvalRequested" }> => event.type === "approvalRequested")
        .map((event) => `${event.approval.action.type}:${"path" in event.approval.action ? event.approval.action.path : event.approval.id}`)
        .join(", ");
      const statuses = harness.events
        .filter((event): event is Extract<AgentUiEvent, { readonly type: "status" }> => event.type === "status")
        .map((event) => event.text)
        .join(" | ");
      reject(new Error(`Timed out waiting for queued same-turn approval. approvals=[${approvals}] statuses=[${statuses}] requests=${harness.provider.requests.length}`));
    }, 1000))
  ]);
  assert.equal(harness.provider.requests.length, 1);

  assert.equal(secondApproval.approval.action.type, "edit_file");
  assert.equal(secondApproval.approval.action.path, "src/b.ts");

  await harness.controller.approve(secondApproval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /same-turn edits/.test(event.text));

  assert.equal(harness.workspace.files.get("src/a.ts"), "export const a = 2;\n");
  assert.equal(harness.workspace.files.get("src/b.ts"), "export const b = 2;\n");
  assert.equal(harness.provider.requests[1]?.messages.filter((message) => message.role === "tool").length, 4);
  assert.ok(harness.provider.requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-read-a"));
  assert.ok(harness.provider.requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-read-b"));
  assert.ok(harness.provider.requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-edit-a"));
  assert.ok(harness.provider.requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-edit-b"));
});

test("Review slash command runs a review prompt instead of spawning a worker", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: [{ content: "No concrete findings." }]
  });

  await harness.controller.sendPrompt("/review src/agent/agentController.ts");

  assert.equal(harness.provider.requests.length, 1);
  assert.equal(harness.provider.requests[0]?.messages.some((message) => /expert code reviewer/.test(message.content)), true);
  assert.equal(harness.provider.requests[0]?.messages.some((message) => /src\/agent\/agentController\.ts/.test(message.content)), true);
  assert.equal(harness.events.some((event) => event.type === "workers" && event.workers.length > 0), false);
});

test("Direct worker launch slash commands are not public commands", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: []
  });

  await harness.controller.sendPrompt("/implement fix labels");
  await harness.controller.sendPrompt("/worker plan add a session picker");

  assert.equal(harness.provider.requests.length, 0);
  assert.equal(harness.events.some((event) => event.type === "workers" && event.workers.length > 0), false);
  assert.equal(harness.events.some((event) =>
    event.type === "message"
    && event.role === "system"
    && /Unknown command \/implement/.test(event.text)
  ), true);
  assert.equal(harness.events.some((event) =>
    event.type === "message"
    && event.role === "system"
    && /Worker commands:/.test(event.text)
  ), true);
});

test("Model-facing spawn_agent still launches isolated workers", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: [
      { toolCalls: [toolCall("spawn_agent", { agent: "explore", prompt: "inspect src/a.ts", background: true }, "call-spawn")] },
      { content: "Delegated exploration." },
      { content: "Scope: src/a.ts\nResult: inspected\nKey files: src/a.ts\nFiles changed: none\nIssues: none\nConfidence: high" }
    ]
  });

  await harness.controller.sendPrompt("Use an explorer for src/a.ts.");
  await waitForEvent(harness.events, (event) => event.type === "workers" && event.workers.length > 0);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /Delegated/.test(event.text));

  const workersEvents = harness.events.filter((event): event is Extract<AgentUiEvent, { readonly type: "workers" }> => event.type === "workers");
  const workersEvent = workersEvents[workersEvents.length - 1];
  assert.equal(workersEvent?.workers.length, 1);
  assert.equal(workersEvent?.workers[0]?.label, "Explore");
});

test("Preview failures still surface an approval instead of failing the request", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "smart",
    files: { "README.md": "# CodeForge\nold\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "README.md" }),
          toolCall("edit_file", { path: "README.md", oldText: "old", newText: "new" })
        ]
      }
    ]
  });
  harness.diff.previewEditFile = async () => {
    throw new Error("preview failed");
  };

  await harness.controller.sendPrompt("Edit README.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");
  assert.match(approval.approval.detail ?? "", /Diff preview unavailable: preview failed/);
  assert.equal(harness.diff.edits.length, 0);
  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\nold\n");
});

test("Manual rejection resumes the model loop so the assistant can choose another path", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("write_file", { path: "REJECTED.md", content: "rejected" })] },
      { content: "I will use a different approach instead of that rejected write." }
    ]
  });

  await harness.controller.sendPrompt("Try creating REJECTED.md.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");

  await harness.controller.reject(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /different approach/.test(event.text));

  assert.equal(harness.diff.writes.length, 0);
  assert.equal(harness.workspace.files.has("REJECTED.md"), false);
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /look for an alternative way/.test(event.text)));
});

test("Approved action execution failures are returned to the model and continue", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "manual",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      {
        toolCalls: [
          toolCall("read_file", { path: "README.md" }),
          toolCall("write_file", { path: "README.md", content: "# Replacement\n" })
        ]
      },
      { content: "I recovered from the failed approved write." }
    ]
  });
  harness.diff.applyWriteFile = async () => {
    throw new Error("simulated apply failure");
  };

  await harness.controller.sendPrompt("Write README.");
  const approval = harness.events.find((event) => event.type === "approvalRequested");
  assert.ok(approval && approval.type === "approvalRequested");

  await harness.controller.approve(approval.approval.id);
  await waitForEvent(harness.events, (event) => event.type === "message" && event.role === "assistant" && /recovered from the failed approved write/.test(event.text));

  assert.equal(harness.workspace.files.get("README.md"), "# CodeForge\n");
  assert.ok(harness.events.some((event) => event.type === "toolResult" && /simulated apply failure/.test(event.text)));
});

test("Invalid native tool calls return tool errors and allow a retry", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: { "README.md": "# CodeForge\n" },
    responses: [
      { toolCalls: [toolCall("does_not_exist", {})] },
      { toolCalls: [toolCall("read_file", { path: "README.md" })] },
      { content: "Recovered after the invalid tool call." }
    ]
  });

  await harness.controller.sendPrompt("Read the README.");

  assertToolFailed(harness.events, "does_not_exist");
  assertToolCompleted(harness.events, "read_file");
  assertAssistantMessage(harness.events, /Recovered after the invalid tool call/);
});

test("Concurrency-safe read tools in one assistant turn all execute", async () => {
  const harness = createControllerHarness({
    mode: "ask",
    files: {
      "README.md": "# CodeForge\n",
      "src/index.ts": "export const value = 1;\n"
    },
    responses: [
      {
        toolCalls: [
          toolCall("list_files", { limit: 10 }, "call-list"),
          toolCall("read_file", { path: "README.md" }, "call-read")
        ]
      },
      { content: "Both read tools completed." }
    ]
  });

  await harness.controller.sendPrompt("List files and read the README.");

  assertToolCompleted(harness.events, "list_files");
  assertToolCompleted(harness.events, "read_file");
  assertAssistantMessage(harness.events, /Both read tools completed/);
});

test("controller loads deferred MCP resource tools and lists configured resources", async () => {
  const fetchLog = withFakeMcpFetch();
  try {
    const harness = createControllerHarness({
      mode: "plan",
      mcpServers: [{ id: "local", label: "Local MCP", transport: "http", url: "http://127.0.0.1:3555/mcp" }],
      responses: [
        { toolCalls: [toolCall("tool_search", { query: "select:mcp_list_resources" })] },
        { toolCalls: [toolCall("mcp_list_resources", { serverId: "local" })] },
        { content: "MCP resources inspected." }
      ]
    });

    await harness.controller.sendPrompt("List local MCP resources.");

    assertToolCompleted(harness.events, "tool_search");
    assertToolCompleted(harness.events, "mcp_list_resources");
    assertToolWasNotOffered(harness.provider.requests[0].tools, "mcp_list_resources");
    assertToolWasOffered(harness.provider.requests[1].tools, "mcp_list_resources");
    assert.ok(fetchLog.methods.includes("resources/list"));
    assertAssistantMessage(harness.events, /MCP resources inspected/);
  } finally {
    fetchLog.restore();
  }
});

test("controller loads concrete MCP tool schemas and maps function calls back to server tools", async () => {
  const fetchLog = withFakeMcpFetch();
  try {
    const harness = createControllerHarness({
      mode: "agent",
      permissionMode: "fullAuto",
      mcpServers: [{ id: "local", label: "Local MCP", transport: "http", url: "http://127.0.0.1:3555/mcp" }],
      responses: [
        { toolCalls: [toolCall("tool_search", { query: "select:mcp__local__tools_echo" })] },
        { toolCalls: [toolCall("mcp__local__tools_echo", { message: "hi" })] },
        { content: "MCP tool call completed." }
      ]
    });

    await harness.controller.sendPrompt("Call the local MCP echo tool.");

    assertToolCompleted(harness.events, "tool_search");
    assertToolCompleted(harness.events, "mcp_call_tool");
    assertToolWasNotOffered(harness.provider.requests[0].tools, "mcp__local__tools_echo");
    assertToolWasOffered(harness.provider.requests[1].tools, "mcp__local__tools_echo");
    assert.deepEqual(fetchLog.toolCalls, [{ name: "tools.echo", arguments: { message: "hi" } }]);
    assertAssistantMessage(harness.events, /MCP tool call completed/);
  } finally {
    fetchLog.restore();
  }
});

function assertToolCompleted(events: readonly AgentUiEvent[], name: string): void {
  assert.ok(events.some((event) => event.type === "toolUse" && event.toolUse.name === name && event.toolUse.status === "completed"), `${name} should complete`);
}

function assertToolFailed(events: readonly AgentUiEvent[], name: string): void {
  assert.ok(events.some((event) => event.type === "toolUse" && event.toolUse.name === name && event.toolUse.status === "failed"), `${name} should fail`);
}

function assertAssistantMessage(events: readonly AgentUiEvent[], pattern: RegExp): void {
  assert.ok(events.some((event) => event.type === "message" && event.role === "assistant" && pattern.test(event.text)), `assistant message should match ${pattern}`);
}

function assertToolWasOffered(tools: readonly { readonly name: string }[] | undefined, name: string): void {
  assert.ok(tools?.some((tool) => tool.name === name), `${name} should be offered`);
}

function assertToolWasNotOffered(tools: readonly { readonly name: string }[] | undefined, name: string): void {
  assert.ok(!tools?.some((tool) => tool.name === name), `${name} should not be offered`);
}

function withFakeMcpFetch(): {
  readonly methods: string[];
  readonly toolCalls: Array<{ readonly name: string; readonly arguments: unknown }>;
  restore(): void;
} {
  const previousFetch = globalThis.fetch;
  const methods: string[] = [];
  const toolCalls: Array<{ readonly name: string; readonly arguments: unknown }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      readonly id?: string;
      readonly method?: string;
      readonly params?: { readonly name?: string; readonly arguments?: unknown; readonly uri?: string };
    };
    if (!body.id) {
      return new Response(undefined, { status: 202 });
    }
    methods.push(body.method ?? "");
    if (body.method === "initialize") {
      return jsonRpc(body.id, { serverInfo: { name: "fake-mcp" } });
    }
    if (body.method === "tools/list") {
      return jsonRpc(body.id, {
        tools: [
          {
            name: "tools.echo",
            description: "Echo a message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false
            }
          }
        ]
      });
    }
    if (body.method === "resources/list") {
      return jsonRpc(body.id, { resources: [{ uri: "file:///notes.md", name: "Notes", mimeType: "text/markdown" }] });
    }
    if (body.method === "resources/read") {
      return jsonRpc(body.id, { contents: [{ uri: body.params?.uri, mimeType: "text/markdown", text: "# Notes" }] });
    }
    if (body.method === "tools/call") {
      toolCalls.push({ name: body.params?.name ?? "", arguments: body.params?.arguments ?? {} });
      return jsonRpc(body.id, { content: [{ type: "text", text: "echo: ok" }] });
    }
    return jsonRpc(body.id, {});
  }) as typeof fetch;

  return {
    methods,
    toolCalls,
    restore() {
      globalThis.fetch = previousFetch;
    }
  };
}

function jsonRpc(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
