// Live skill-building smoke: drive the real controller through a multi-step, tool-using task plus a
// correction (a first-class "build a skill" signal in Hermes), then watch the background SKILL review
// author a SKILL.md. The skill cadence is iteration-gated, so the main turns must actually call tools.
//
//   CODEFORGE_SMOKE_BASE_URL=http://10.10.10.10:8000 CODEFORGE_SMOKE_MODEL=unsloth/gemma-4-12b-it-GGUF \
//   node out-test/test/smoke/liveSkillSmoke.js

import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { ProviderProfile } from "../../src/core/types";
import { AgentUiEvent } from "../../src/agent/agentController";
import { createControllerHarness } from "../harness/agentControllerHarness";
import { fakeSkillIo } from "../unit/helpers/fakeSkillIo";

const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://10.10.10.10:8000";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "unsloth/gemma-4-12b-it-GGUF";

function reviewSummaries(events: readonly AgentUiEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentUiEvent, { type: "message" }> => e.type === "message" && e.role === "system" && /Self-improvement review/.test(e.text))
    .map((e) => e.text);
}

function toolUseCount(events: readonly AgentUiEvent[]): number {
  return events.filter((e) => e.type === "toolUse").length;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const profile: ProviderProfile = { id: "live", label: "Live", baseUrl, defaultModel: model };
  const provider = new OpenAiCompatibleProvider(profile, { allowlist: [] }, { streamCompletionGraceMs: 60_000, streamQuietExtensions: 2 });
  console.log(`[live] endpoint=${baseUrl} model=${model}`);
  console.log(`[live] capabilities: nativeToolCalls=${(await provider.probeCapabilities(model)).nativeToolCalls}`);

  const skillIo = fakeSkillIo();
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: {
      "CODEFORGE.md": "# Repo conventions\n\nTools live in `src/tools/`. Each tool is a module that exports `run(input: string): string`, and is registered in `src/tools/registry.ts`.\n",
      "src/tools/echo.ts": "export function run(input: string): string {\n  return input;\n}\n",
      "src/tools/registry.ts": "import { run as echo } from \"./echo\";\n\nexport const tools: Record<string, (input: string) => string> = {\n  echo\n};\n"
    },
    responses: [],
    liveProvider: provider,
    skillIo,
    memorySettings: { nudgeInterval: 1, skillNudgeInterval: 1, reviewMinTurns: 1 }
  });
  const events = harness.events;

  console.log("\n[live] TURN 1: add a tool following the repo pattern (should read + write files) …");
  await harness.controller.sendPrompt(
    "Add a new tool named `reverse` that returns the input reversed, following this repo's existing pattern. " +
      "First read src/tools/echo.ts and src/tools/registry.ts, then create src/tools/reverse.ts and register it in the registry."
  );
  console.log(`[live] tool uses so far: ${toolUseCount(events)}`);

  console.log("\n[live] TURN 2: correction — a missing convention step (a first-class skill signal) …");
  await harness.controller.sendPrompt(
    "You forgot the test. In this repo, every new tool MUST also have a test at test/tools/<name>.test.ts. " +
      "Add test/tools/reverse.test.ts now, and remember this rule: adding a tool always requires creating its test too."
  );
  console.log(`[live] tool uses so far: ${toolUseCount(events)}`);

  console.log("\n[live] waiting up to 120s for the SKILL review to author a SKILL.md …");
  await waitFor(() => [...skillIo.files.keys()].some((k) => k.endsWith("SKILL.md")), 120_000);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const skillFiles = [...skillIo.files.keys()].filter((k) => k.endsWith("SKILL.md"));
  const memories = harness.memory.memories.map((m) => `[${m.scope}] ${m.text}`);

  console.log("\n========================= LIVE SKILL RESULT =========================");
  console.log(`tool iterations in main turns : ${toolUseCount(events)}`);
  console.log("review summaries              :");
  for (const s of reviewSummaries(events)) {
    console.log("   " + s.replace(/\n/g, " "));
  }
  console.log("memories saved                :", JSON.stringify(memories, null, 2));
  console.log("skills built                  :", JSON.stringify(skillFiles));
  for (const key of skillFiles) {
    console.log(`\n  --- ${key} ---\n${skillIo.files.get(key)}`);
  }
  console.log("=====================================================================\n");

  console.log(skillFiles.length > 0 ? "[live] PASS — the real model built a skill through the review loop." : "[live] NO SKILL — the review ran but did not author a skill this run.");
}

main().catch((error) => {
  console.error("[live] FAIL", error);
  process.exit(1);
});
