// Live smoke for the SQLite holographic backend: enable it, teach durable facts through the loop
// (the review mirrors curated-memory writes into the fact store), then show recall + the compositional
// probe operation against a real model.
//
//   CODEFORGE_SMOKE_BASE_URL=http://10.10.10.10:8000 CODEFORGE_SMOKE_MODEL=unsloth/gemma-4-12b-it-GGUF \
//   node out-test/test/smoke/liveHolographicSmoke.js

import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { ProviderProfile } from "../../src/core/types";
import { AgentUiEvent } from "../../src/agent/agentController";
import { HolographicMemoryProvider } from "../../src/core/holographic/holographicProvider";
import { BinaryStore } from "../../src/core/holographic/sqlite";
import { createControllerHarness } from "../harness/agentControllerHarness";
import { fakeSkillIo } from "../unit/helpers/fakeSkillIo";

const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://10.10.10.10:8000";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "unsloth/gemma-4-12b-it-GGUF";

function memBinaryStore(): BinaryStore {
  let bytes: Uint8Array | undefined;
  return {
    async load() {
      return bytes;
    },
    async save(b) {
      bytes = new Uint8Array(b);
    }
  };
}

async function factCount(holo: HolographicMemoryProvider): Promise<number> {
  return JSON.parse(await holo.handleToolCall("fact_store", { action: "list" })).count ?? 0;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await predicate())) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function main(): Promise<void> {
  const profile: ProviderProfile = { id: "live", label: "Live", baseUrl, defaultModel: model };
  const provider = new OpenAiCompatibleProvider(profile, { allowlist: [] }, { streamCompletionGraceMs: 45_000, streamQuietExtensions: 2 });
  console.log(`[live] endpoint=${baseUrl} model=${model} provider=holographic (sql.js)`);

  const holo = new HolographicMemoryProvider(memBinaryStore());
  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: {},
    responses: [],
    liveProvider: provider,
    skillIo: fakeSkillIo(),
    externalMemoryProvider: holo,
    memorySettings: { nudgeInterval: 1, skillNudgeInterval: 0, reviewMinTurns: 1 }
  });
  const events: AgentUiEvent[] = harness.events;

  console.log("\n[live] teaching durable facts through the loop …");
  await harness.controller.sendPrompt(
    "Remember these for the long term: our staging database is Postgres 16 running on host db-staging.internal, and the staging cache is Redis 7 running on host cache-staging.internal. Acknowledge briefly."
  );

  console.log("[live] waiting for the review to save + mirror into the durable store …");
  await waitFor(async () => (await factCount(holo)) > 0, 90_000);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const reviewMsg = events.find((e) => e.type === "message" && e.role === "system" && /Self-improvement review/.test(e.text));

  console.log("\n========================= LIVE HOLOGRAPHIC RESULT =========================");
  console.log("review summary :", reviewMsg && reviewMsg.type === "message" ? reviewMsg.text : "(none)");
  console.log("durable facts  :", await holo.handleToolCall("fact_store", { action: "list" }));
  console.log("\nsearch 'what database does staging use':");
  console.log("  ", await holo.handleToolCall("fact_store", { action: "search", query: "what database does staging use" }));
  console.log("\nprobe entity 'Postgres' (compositional HRR recall):");
  console.log("  ", await holo.handleToolCall("fact_store", { action: "probe", entity: "Postgres" }));
  console.log("\nprefetch 'which host runs the staging cache' (what auto-injects into context):");
  console.log("  ", JSON.stringify(await holo.prefetch("which host runs the staging cache")));
  console.log("===========================================================================\n");

  const count = await factCount(holo);
  console.log(count > 0 ? `[live] PASS — ${count} durable fact(s) in the SQLite store, recalled via search/probe/prefetch.` : "[live] PARTIAL — the loop ran but nothing was mirrored into the durable store this run.");
}

main().catch((error) => {
  console.error("[live] FAIL", error);
  process.exit(1);
});
