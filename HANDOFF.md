# CodeForge Handoff

Last updated: 2026-06-03

## Project Direction

CodeForge is a VS Code extension-only local coding assistant. It is not a CLI tool and does not provide a browser or website workflow. The extension talks to local or on-prem OpenAI API compatible endpoints such as LM Studio, vLLM, and LiteLLM.

Keep these design constraints intact:

- local/offline-first behavior
- no telemetry
- no bundled cloud-provider presets
- no public web fetch/search tools
- no CLI edition
- network access limited to localhost, private IP ranges, and explicitly allowlisted on-prem hosts
- all file edits, commands, MCP service calls, and memory writes routed through typed tools and permission policy

## Current State (v0.1.10)

Core product (Phases 0–11) is unchanged and described in the git history. Two recent bodies of work sit on top:

1. **Approval-continuation fix** (v0.0.10): after approving an edit/command in Smart/Manual modes the loop continues. Root cause was a `tool → user` adjacency injected into the post-approval request that local chat templates mis-render; the fix re-requests the transcript ending in the tool result (matching the working Full-Auto path) and folds the "keep going" guidance into the tool result. See `agentController.ts` `runModelLoop` / `approve`.

2. **Hermes-style learning + multi sub-agent system** (this session) — described below.

**Tests: 174 pass / 0 fail.** `tsc` clean, extension compiles. Run:
```bash
npm run compile && npm run compile:tests && node --test out-test/test/unit/*.test.js out-test/test/integration/*.test.js
```

## Learning + multi-agent system

### What it does
After a finished Agent-mode task, CodeForge distils durable **lessons** from its own work (corrective on failure, reusable on success), stores them, and injects the relevant ones into future prompts — for the main loop **and** sub-agents. Repeated successful procedures are proposed as reusable **skills**; recurring task types are proposed as review-only **sub-agents**. A periodic self-audit dedups/prunes the lesson library. A `.codeforge/soul.md` persona shapes tone. Sub-agents run with a concurrency cap and can be joined.

### Hermes → CodeForge mapping
- Memory → learned lessons as `MemoryEntry` rows (a parseable `[codeforge-learned …]` tag line in `text`); user-scoped persists cross-repo via `globalStorageUri`.
- Skills → `.codeforge/skills/<name>/SKILL.md` (existing loader).
- Soul → `.codeforge/soul.md` injected (bounded) into the system prompt.
- Self-improving loop → extraction on run-complete + periodic audit.
- Sub-agents → `WorkerManager` (concurrency-capped, lesson/skill-aware).

### New modules
- `src/core/learning.ts` — lesson (de)serialization, extraction prompt + tolerant parser, ranking, bounded digest, settings normalizers.
- `src/core/skillProposal.ts` — procedure clustering, skill prompt/parse/render, `formatSkillsDigest` (worker skill injection).
- `src/core/agentProposal.ts` — agent prompt/parse (tools validated against the registry)/render. **Review-only.**
- `src/core/learningAudit.ts` — audit prompt, plan parser, deterministic overflow eviction.
- `src/adapters/worktree.ts` — `GitWorktreeManager` (git worktree create/diff/remove). **Adapter only — not yet wired into workers (see Next steps).**

### Key changed files
- `src/agent/agentController.ts` — `maybeLearnFromRun` (fire-and-forget on `emitRunCompleteIfIdle` idle; `learningInFlight` + slice-baseline guards), `collectRunSignals`, `maybeProposeSkill` / `maybeProposeAgent`, `runLearningAudit`, `buildLearnedDigest`, `workerLearnedDigest` / `workerSkillsDigest`, `memoriesForWorker` (now `plainMemoriesFrom`), soul injection in `systemMessage`, `worker_output` `wait` handling, accept/reject lesson|skill|agent + pending maps.
- `src/agent/workerManager.ts` — concurrency cap (`activeRuns`/`runQueue`/`pump`/`enqueueRun`), `learnedDigest`/`skillsDigest` options.
- `src/core/contextBuilder.ts` — `learnedDigest` + `skillsDigest` sources.
- `src/adapters/vscodeMemoryStore.ts` — split workspace/global persistence with merge+dedup.
- `src/core/session.ts` / `sessionMigration.ts` — `SessionLearningRecord`.
- `src/core/localExtensions.ts` — `loadLocalSoul`, exported `isSafeExtensionName`.
- `media/main.js` + `src/ui/codeForgeViewProvider.ts` — **Learned** settings tab (accept/reject lessons, skills, agents).

### Configuration (`codeforge.*`)
- `learning.enabled` (true), `learning.autonomy` (review|hybrid|auto, default review), `learning.scope` (split|repo|global, default split)
- `learning.auditCadence` (15), `learning.maxLessons` (60), `learning.maxLessonBytes` (24000)
- `learning.skills.enabled` (true), `learning.skills.minRepeats` (3)
- `learning.agents.enabled` (**false** — opt-in; agents are review-only)
- `learning.embeddings.enabled` (false — **declared but not yet wired**, see Next steps)
- `workers.maxConcurrent` (3)

### Autonomy / safety rules (do not regress)
- Learning is **fire-and-forget and fully guarded** — it must never block or break a run.
- `review` autonomy → lessons are stored `proposed` and are **not** injected until accepted; `hybrid`/`auto` store them `accepted`.
- **Agents are always review-only**, even under `autonomy: "auto"`. Proposed agent tools are validated against the real registry.
- Skill/agent file writes go through `diff.applyWriteFile`; nothing is written without accept except skills under `autonomy: "auto"`.

## Code review done this session (all fixed)
An adversarial multi-agent review confirmed 4 issues; all fixed + covered or reasoned:
1. **[high]** `maybeLearnFromRun` advanced the learning baseline before persisting → a failed `memoryStore.add` lost the lesson. Fixed: advance baseline only when all persists succeed; added exact-text dedup so a retry pass doesn't duplicate. Regression test: "Re-extracting an identical lesson does not duplicate it".
2. **[med]** `maybeProposeSkill` recorded the cluster signature before parse/validation → a transient parse failure permanently blocked retry. Fixed: record signature only after a valid parse.
3. **[med]** Same pattern in `maybeProposeAgent`. Fixed the same way.
4. **[med]** `loadLocalSoul` truncated by characters, not bytes. Fixed: `Buffer.from(...).subarray(0, maxSoulBytes)`.

## Next steps (ordered) — additional improvements discovered

1. **Wire 1b (worktree isolation) into editing workers.** The adapter is built+tested; the wiring is deferred because it touches VS Code-bound file I/O that the in-memory harness can't exercise. Plan:
   - Add `codeforge.workers.isolateEditors` (default false).
   - When an editing worker (`implement`/custom with write tools) spawns under isolation, `GitWorktreeManager.create()` a worktree; thread its path as a per-worker filesystem root through `executeWorkerAction` → the diff service / `WorkspacePort` so the worker's `write_file`/`edit_file` land in the worktree.
   - On worker completion, `captureDiff()` and surface it to the main tree as a **`propose_patch` approval** (never auto-apply); `remove()` the worktree in a `finally`.
   - This requires the file-op path to accept a root override — currently everything resolves against the workspace root. That is the main work and the main risk. Verify manually against a real git workspace (the harness can't).
2. **Embeddings retrieval (opt-in).** `learning.embeddings.enabled` is declared but unused. Add `src/adapters/openaiEmbeddings.ts` calling the configured profile's `/embeddings`, cache vectors beside `memories.json`, and blend cosine similarity into `rankLessonsForPrompt`. Keep lexical ranking the default (many local servers lack `/embeddings`).
3. **User-global soul.** `loadLocalSoul` reads only the workspace `.codeforge/soul.md`. Add a cross-repo soul from extension global storage (needs the controller to reach `ExtensionContext`, like the memory store does), workspace winning on overlap.
4. **Inject the persona into sub-agents too.** Soul currently only reaches the main loop's `systemMessage`; thread it into `WorkerManager.systemPrompt` for consistent voice.
5. **Unify `pendingSkills` + `pendingAgents` into `pendingArtifacts`** (skill|agent) to remove duplication across the maps, accept/reject methods, state, events, and UI render functions.
6. **`pendingContinuation` is a single slot** (`agentController.ts`). Two approvals approved while a run is active → the first parked continuation is overwritten/lost. Convert `pendingContinuation` to a FIFO queue and gate `emitRunCompleteIfIdle` on its length. (Pre-existing from the approval-fix session, not introduced here.)
7. **#5 crons — deferred (poor fit).** A VS Code extension has no background daemon, so unattended cron runs don't map. If pursued: a session-scoped scheduler (`setInterval` while the editor is open) that re-runs a saved prompt, surfaced as a "scheduled prompts" list — low value relative to the above. Do not build a fake daemon.

## Behavior notes / known limitations
- With `learning.enabled` default **true**, every finished Agent task that used tools triggers one extra background LLM call (extraction). On slow local models this adds post-task latency. Toggle off, or consider defaulting `enabled` to false if users complain.
- Lesson dedup is **exact-text** only; near-duplicates rely on the periodic audit to consolidate.
- The extraction transcript is capped (~12000 chars of the recent slice); very large tasks are summarized by truncation.
- Worker concurrency default is 3; raise `workers.maxConcurrent` cautiously for a single local endpoint.

## Important files (quick map)
- Orchestration / learning loop: `src/agent/agentController.ts`
- Sub-agents: `src/agent/workerManager.ts`, `src/core/workerAgents.ts`
- Learning core: `src/core/learning.ts`, `skillProposal.ts`, `agentProposal.ts`, `learningAudit.ts`
- Worktree adapter: `src/adapters/worktree.ts`
- Context assembly: `src/core/contextBuilder.ts`
- Tools: `src/core/toolRegistry.ts`
- Memory persistence: `src/adapters/vscodeMemoryStore.ts`
- UI: `media/main.js`, `src/ui/codeForgeViewProvider.ts`
- Roadmap design: `docs/hermes-roadmap.md`

## Known local endpoint
`http://127.0.0.1:1234`, model `google/gemma-4-e4b`. Use for live smoke testing when running.

## Session notes for next agent
- Follow the ports-and-adapters boundaries; keep `src/core/*` testable without `vscode` imports (that is why `learning.ts`/`skillProposal.ts`/`agentProposal.ts`/`learningAudit.ts` are pure).
- New `src/core` logic should ship with a focused unit test; controller behavior with a harness integration test (`test/harness/agentControllerHarness.ts`, `ScriptedLlmProvider`, `FakeMemoryStore`).
- The harness defaults `learning.enabled` to **false** so existing tests are unaffected; opt in per-test via `learningSettings`.
- Run `npm run compile && npm run compile:tests && node --test out-test/test/unit/*.test.js out-test/test/integration/*.test.js` before handoff.
- Do not add public web tools, cloud presets, telemetry, CLI commands, or browser preview workflows.
