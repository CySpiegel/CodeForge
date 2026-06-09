// Live end-to-end smoke for the Hermes-style self-learning loop against a real OpenAI-compatible
// endpoint. Drives the real controller with a live LLM + a fake skill store, sends a prompt designed
// to teach a durable preference + a procedure, then waits for the background self-improvement review
// and reports what the REAL model actually saved to memory / built as a skill.
//
//   CODEFORGE_SMOKE_BASE_URL=http://10.10.10.10:8000 CODEFORGE_SMOKE_MODEL=unsloth/gemma-4-12b-it-GGUF \
//   node out-test/test/smoke/liveLoopSmoke.js

import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { ProviderProfile } from "../../src/core/types";
import { AgentUiEvent } from "../../src/agent/agentController";
import { createControllerHarness } from "../harness/agentControllerHarness";
import { fakeSkillIo } from "../unit/helpers/fakeSkillIo";

const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://10.10.10.10:8000";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "unsloth/gemma-4-12b-it-GGUF";

function lastOfRole(events: readonly AgentUiEvent[], role: "assistant" | "system"): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "message" && event.role === role) {
      return event.text;
    }
  }
  return "";
}

function reviewSummary(events: readonly AgentUiEvent[]): string | undefined {
  const hit = events.find(
    (event) => event.type === "message" && event.role === "system" && /Self-improvement review/.test(event.text)
  );
  return hit && hit.type === "message" ? hit.text : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}

async function main(): Promise<void> {
  const profile: ProviderProfile = { id: "live", label: "Live", baseUrl, defaultModel: model };
  const provider = new OpenAiCompatibleProvider(profile, { allowlist: [] }, { streamCompletionGraceMs: 45_000, streamQuietExtensions: 2 });

  console.log(`[live] endpoint=${baseUrl} model=${model}`);
  const inspection = await provider.inspectEndpoint();
  console.log(`[live] backend=${inspection.backendLabel} models=${inspection.models.map((m) => m.id).join(", ")}`);
  const caps = await provider.probeCapabilities(model);
  console.log(`[live] capabilities: nativeToolCalls=${caps.nativeToolCalls} streaming=${caps.streaming}`);
  console.log(caps.nativeToolCalls ? "[live] → review will use native tool calls" : "[live] → review will use the JSON action-protocol fallback (fix #1 path)");

  const skillIo = fakeSkillIo();
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: { "README.md": "# Demo repo\n" },
    responses: [],
    liveProvider: provider,
    skillIo,
    memorySettings: { nudgeInterval: 1, skillNudgeInterval: 1, reviewMinTurns: 1 }
  });
  const events = harness.events;

  console.log("\n[live] sending prompt (teaches a durable preference + a repo procedure) …");
  await harness.controller.sendPrompt(
    "From now on, always answer me with terse bullet points — never long paragraphs. Also note: in this repo, you run the tests with `npm test` and build with `npm run compile`. Acknowledge in one line."
  );
  console.log(`[live] main turn done. Assistant: ${JSON.stringify(lastOfRole(events, "assistant").slice(0, 160))}`);

  console.log("[live] waiting up to 90s for the background self-improvement review to act …");
  const saved = () =>
    harness.memory.memories.length > 0 || [...skillIo.files.keys()].some((key) => key.endsWith("SKILL.md"));
  await waitFor(() => Boolean(reviewSummary(events)) || saved(), 90_000);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const userMemories = harness.memory.memories.filter((m) => m.scope === "user").map((m) => m.text);
  const memoryNotes = harness.memory.memories.filter((m) => m.scope !== "user").map((m) => m.text);
  const skillFiles = [...skillIo.files.keys()].filter((key) => key.endsWith("SKILL.md"));

  console.log("\n========================= LIVE RESULT =========================");
  console.log("Review summary :", reviewSummary(events) ?? "(no review summary emitted)");
  console.log("USER memories  :", JSON.stringify(userMemories, null, 2));
  console.log("MEMORY notes   :", JSON.stringify(memoryNotes, null, 2));
  console.log("Skills built   :", JSON.stringify(skillFiles));
  for (const key of skillFiles) {
    console.log(`\n  --- ${key} ---\n${skillIo.files.get(key)}`);
  }
  console.log("===============================================================\n");

  const total = userMemories.length + memoryNotes.length + skillFiles.length;
  console.log(
    total > 0
      ? `[live] PASS — the real model's review produced ${total} memory/skill item(s) through the full loop.`
      : "[live] PARTIAL — the loop ran end-to-end but the model chose to save nothing this run (try rerunning or a stronger model)."
  );
}

main().catch((error) => {
  console.error("[live] FAIL", error);
  process.exit(1);
});
