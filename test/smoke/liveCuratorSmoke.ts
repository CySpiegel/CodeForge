// Live curator smoke: seed several overlapping, agent-created skills (a prefix cluster), then run the
// real curator consolidation pass against a live model and report what it merged/archived. Exercises
// the LLM "umbrella-building" pass + the archive (never-delete) + structured-summary path.
//
//   CODEFORGE_SMOKE_BASE_URL=http://10.10.10.10:8000 CODEFORGE_SMOKE_MODEL=unsloth/gemma-4-12b-it-GGUF \
//   node out-test/test/smoke/liveCuratorSmoke.js

import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { ProviderProfile } from "../../src/core/types";
import { createControllerHarness } from "../harness/agentControllerHarness";
import { fakeSkillIo, FakeSkillIo } from "../unit/helpers/fakeSkillIo";
import { SKILLS_ROOT, SKILLS_ARCHIVE, CURATOR_BACKUPS, USAGE_FILE, skillMdPath } from "../../src/core/skillIo";

const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://10.10.10.10:8000";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "unsloth/gemma-4-12b-it-GGUF";

const SKILLS: Record<string, [string, string]> = {
  "pr-review-security": ["Review a pull request for security issues", "When reviewing a PR, check for SQL injection, secrets committed in code, unsafe deserialization, and missing authorization checks."],
  "pr-review-performance": ["Review a pull request for performance issues", "When reviewing a PR, check for N+1 queries, unnecessary allocations, missing database indexes, and blocking I/O on hot paths."],
  "pr-review-style": ["Review a pull request for style issues", "When reviewing a PR, check naming consistency, formatting, dead code, and comment quality."],
  "deploy-to-staging": ["Deploy the app to staging", "Run `npm run build`, then `./scripts/deploy.sh staging`, then smoke-test the staging URL."]
};

function skillMd(name: string, [description, body]: [string, string]): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${description}\n\n${body}\n`;
}

function agentRecord(nowIso: string) {
  return {
    created_by: "agent",
    use_count: 1,
    view_count: 0,
    patch_count: 0,
    last_used_at: nowIso,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: nowIso,
    state: "active",
    pinned: false,
    archived_at: null
  };
}

function liveSkillNames(io: FakeSkillIo): string[] {
  return [...io.files.keys()]
    .filter((k) => k.startsWith(`${SKILLS_ROOT}/`) && k.endsWith("SKILL.md") && !k.startsWith(`${SKILLS_ARCHIVE}/`) && !k.startsWith(`${CURATOR_BACKUPS}/`))
    .map((k) => k.slice(`${SKILLS_ROOT}/`.length).replace(/\/SKILL\.md$/, ""));
}

function archivedSkillNames(io: FakeSkillIo): string[] {
  return [...io.files.keys()]
    .filter((k) => k.startsWith(`${SKILLS_ARCHIVE}/`) && k.endsWith("SKILL.md"))
    .map((k) => k.slice(`${SKILLS_ARCHIVE}/`.length).replace(/\/SKILL\.md$/, ""));
}

async function main(): Promise<void> {
  const profile: ProviderProfile = { id: "live", label: "Live", baseUrl, defaultModel: model };
  const provider = new OpenAiCompatibleProvider(profile, { allowlist: [] }, { streamCompletionGraceMs: 60_000, streamQuietExtensions: 2 });
  console.log(`[live] endpoint=${baseUrl} model=${model} nativeToolCalls=${(await provider.probeCapabilities(model)).nativeToolCalls}`);

  const nowIso = new Date().toISOString();
  const seed: Record<string, string> = {};
  const usage: Record<string, unknown> = {};
  for (const [name, content] of Object.entries(SKILLS)) {
    seed[skillMdPath(name)] = skillMd(name, content);
    usage[name] = agentRecord(nowIso);
  }
  seed[USAGE_FILE] = JSON.stringify(usage, null, 2);
  const skillIo = fakeSkillIo(seed);

  const harness = createControllerHarness({
    mode: "agent",
    permissionMode: "fullAuto",
    files: {},
    responses: [],
    liveProvider: provider,
    skillIo,
    // Disable the per-turn review so only the curator runs.
    memorySettings: { nudgeInterval: 0, skillNudgeInterval: 0, reviewMinTurns: 999 }
  });

  console.log("\n[live] agent-created skills BEFORE:", JSON.stringify(liveSkillNames(skillIo)));
  console.log("[live] running the curator consolidation pass (umbrella-building) … this makes many model calls\n");
  const result = await harness.controller.runCurator({ dryRun: false });

  const before = new Set(Object.keys(SKILLS));
  const liveAfter = liveSkillNames(skillIo);
  const archivedAfter = archivedSkillNames(skillIo);
  const created = liveAfter.filter((n) => !before.has(n));

  console.log("\n========================= LIVE CURATOR RESULT =========================");
  console.log("curator message    :", result);
  console.log("live skills AFTER  :", JSON.stringify(liveAfter));
  console.log("archived AFTER     :", JSON.stringify(archivedAfter));
  console.log("newly created      :", JSON.stringify(created));
  for (const name of created) {
    console.log(`\n  --- NEW UMBRELLA ${name} ---\n${skillIo.files.get(skillMdPath(name))}`);
  }
  // Show a surviving pr-review umbrella if one was patched in place.
  for (const name of liveAfter.filter((n) => before.has(n) && n.includes("pr-review"))) {
    console.log(`\n  --- SURVIVING ${name} (possibly patched) ---\n${skillIo.files.get(skillMdPath(name))}`);
  }
  console.log("=======================================================================\n");

  const consolidated = archivedAfter.length > 0 || created.length > 0;
  console.log(consolidated ? "[live] PASS — the curator consolidated/archived skills (recoverable; never deleted)." : "[live] NO CHANGE — the curator ran but left the library as-is this run.");
}

main().catch((error) => {
  console.error("[live] FAIL", error);
  process.exit(1);
});
