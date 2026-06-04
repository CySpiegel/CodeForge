# CodeForge Handoff

Last updated: 2026-06-04

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

## Current State (v0.1.12)

Core product (Phases 0–11) is unchanged and described in the git history. Three recent bodies of work sit on top:

1. **Approval-continuation fix** (v0.0.10): after approving an edit/command in Smart/Manual modes the loop continues. Root cause was a `tool → user` adjacency injected into the post-approval request that local chat templates mis-render; the fix re-requests the transcript ending in the tool result (matching the working Full-Auto path) and folds the "keep going" guidance into the tool result. See `agentController.ts` `runModelLoop` / `approve`.

2. **Hermes-style learning + multi sub-agent system** (v0.1.11) — described below.

3. **Tool-call reliability + output-token control** (v0.1.12, this session) — described below.

**Tests: 189 pass / 0 fail.** `tsc` clean, extension compiles. Run:
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

## Learning visibility + Learned-panel fix (this session)

Symptom reported: "I don't see it learning like Hermes" + "Accept/Reject in the Learned panel do nothing."

Root causes found:
1. **Inert by default.** `learning.autonomy` defaulted to `review`, so every lesson was stored `proposed`, and `buildLearnedDigest` only injects `accepted` lessons. Out of the box nothing was ever applied unless the user manually accepted each lesson.
2. **Silent.** The only user-facing signal was the Inspector panel / a Learned-tab badge — nothing appeared in the conversation, so even a working learn→apply cycle was invisible.
3. **Dead Accept/Reject buttons** (webview-only). The controller path (`acceptLesson`/`rejectLesson`/`restatusLesson` → `memoryStore.update/remove` → `publishState`) is correct and covered by a passing integration test (`agentPipeline.test.ts` "Learned panel accepts and rejects…"). The test calls the controller directly, bypassing the webview, so a webview-runtime refresh issue went uncaught.

Changes:
- **Default `learning.autonomy` → `hybrid`** (`package.json` + `vscodeConfig.ts`; contract test updated). Text lessons now apply immediately; skill/agent files stay review-only.
- **Inline `🧠 Learned N…` chat message** in `maybeLearnFromRun` (lists the stored lessons; says "applied" vs "review in the Learned panel").
- **`📎 Applied N learned lessons` provenance** in `runPrompt`. `buildLearnedDigest` now returns `{ text, count }`; `workerLearnedDigest` uses `?.text`.
- **Webview hardening** (`media/main.js`): added incremental handlers for `learningProposed`/`skillProposed`/`agentProposed`; made Accept/Reject **optimistic** (mutate local state + re-render immediately, so the action is unmistakable even if a state publish lags); added a pending-count badge to the **Learned** tab (`Learned (N)`).
- New integration test: "Learning surfaces inline chat messages when it learns and when it applies a lesson."

**Tests: 190 pass / 0 fail.**

Note: the exact dead-button cause could not be reproduced by static analysis (controller logic is correct + test-covered); the optimistic webview update both hardens the untested layer and gives instant feedback. If buttons still feel dead in the live extension, check the webview Developer Tools console for an exception thrown inside `renderState()` before `renderLearned()` runs.

## Tool-call reliability + output-token control (v0.1.12)

Local models (e.g. `gemma-4-31B-it` served via LiteLLM) truncate tool-call arguments mid-string. A multi-agent diagnosis (4 parallel investigators + adversarial verifiers + synthesis) traced **one root cause behind three reported symptoms**, plus a latent model-metadata bug. All fixed; **189 tests pass**. Shipped as v0.1.12 (commit `781616e`, tag `v0.1.12`).

### Symptoms → fixes
1. **LiteLLM HTTP 400 "Unterminated string"** — a truncated `argumentsJson` was replayed verbatim on the next request; LiteLLM `json.loads` the `arguments` field and rejected the whole body. **Fix:** `sanitizeToolArgumentsJson` (+ `repairTruncatedJsonObject` / `isJsonObjectString`) in `openaiAdapter.ts` sanitizes tool-call arguments to valid JSON **at the serialization boundary** (`toOpenAiMessage`). The raw malformed args stay in history so the parse failure still surfaces to the model and the retry loop recovers. **Do not** filter invalid calls out of history (the adversarial verifier rejected that — it hides the failure from the model).
2. **Tool-call truncation at the source** — no `max_tokens` was sent, so some endpoints applied a tiny built-in default that cut the JSON. **Fix:** added `maxTokens` to `LlmRequest`, forwarded in `fetchChatStream`, and `resolveRequestMaxTokens(model, ctxLimit, preference)` feeds every model turn (6 `agentController` request sites + `workerManager`, centralized via `requestMaxTokens()` / the `WorkerManagerOptions.requestMaxTokens` accessor). See setting below.
3. **"Full Auto keeps asking for approvals"** — **NOT a permissions regression.** `git diff <prev> HEAD -- src/core/permissions.ts` is empty; `ask_user_question` intentionally always prompts (Full Auto cannot answer for the user). The constant prompts were downstream **thrash from the truncation loop**; fixing 1–2 resolves it. Added a permissions invariant-lock test so it is not "fixed" by accident.
4. **LiteLLM context length misread as the output limit** — LiteLLM reports each served model's context length under `max_tokens` in `/v1/models`. It sat in the `maxOutputTokens` key list. **Fix:** moved `max_tokens` / `max_input_tokens` into the `contextLength` key list (lowest priority, so a more specific `max_model_len`/`context_length` still wins; read **per-model**). The context window maximum is now detected automatically and flows into `contextWindowMaxTokens()` → context budget + auto-compaction.

### New setting
`codeforge.model.maxOutputTokens` (default **32000**):
- `32000` (default) — cap output at ~32k (matches Claude Code), **bounded to half the context window and the model's reported output limit** so it stays safe on small-context models (e.g. a 32k-ctx model → 16384).
- `0` — **no limit**: omit `max_tokens`; the endpoint/model decides (on vLLM, up to remaining context). Use for the largest single response.
- `>= 1` — custom cap, same safe bounding.
Logic lives in `resolveRequestMaxTokens` (`src/core/openaiAdapter.ts`); the package.json default and `DEFAULT_MAX_OUTPUT_TOKENS` must stay in sync (locked by a `packageContract` test).

### Reference: how the real harness does it
`/home/spiegel/Projects/Harnes` is a reverse-engineered Claude Code internals dump — search it for "how does the harness do X". Claude Code **always** sends `max_tokens` (the Anthropic Messages API requires it), defaulting to the model's max output (~32k), user-overridable via `CLAUDE_CODE_MAX_OUTPUT_TOKENS` clamped to the model's 64k upper limit, with **escalate-on-truncation retry** (cap low, retry once at 64k on `finish_reason: "length"`). Not ported: that escalation retry (see Next steps).

## Code review — learning/multi-agent session (v0.1.11, all fixed)
An adversarial multi-agent review confirmed 4 issues; all fixed + covered or reasoned:
1. **[high]** `maybeLearnFromRun` advanced the learning baseline before persisting → a failed `memoryStore.add` lost the lesson. Fixed: advance baseline only when all persists succeed; added exact-text dedup so a retry pass doesn't duplicate. Regression test: "Re-extracting an identical lesson does not duplicate it".
2. **[med]** `maybeProposeSkill` recorded the cluster signature before parse/validation → a transient parse failure permanently blocked retry. Fixed: record signature only after a valid parse.
3. **[med]** Same pattern in `maybeProposeAgent`. Fixed the same way.
4. **[med]** `loadLocalSoul` truncated by characters, not bytes. Fixed: `Buffer.from(...).subarray(0, maxSoulBytes)`.

## Next steps (ordered) — additional improvements discovered

### Tool-call reliability follow-ups (from v0.1.12, optional)
- **Escalate-on-truncation retry (Claude Code parity).** Surface `finish_reason: "length"` from `openaiAdapter` (currently any finish_reason just stops the stream) and, when a turn is truncated under a non-zero `maxOutputTokens`, retry once with a higher/`0` cap before giving up. This is the one piece of Claude Code's policy not ported. Lower priority now that the default is a generous 32k and `0` (no limit) is one setting away.
- **Inbound tool-arg repair (deliberately skipped).** Repair is applied only at the *outbound* serialization boundary; the inbound parse (`parseToolActionDetailed`) still hard-fails a truncated call. Repairing inbound could let a recoverable read-only call run, but risks executing valid-but-wrong args (e.g. a truncated path) — gate to read-only tools + re-validate via `validateAction` if pursued. With `max_tokens` preventing truncation and the retry loop self-healing, it was left out.

### Carried over from v0.1.11
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
- Endpoint / streaming / model discovery / `max_tokens` / tool-arg sanitize: `src/core/openaiAdapter.ts`
- Tool-call argument parsing: `src/core/actionProtocol.ts`
- Permissions / approval modes: `src/core/permissions.ts`, `src/core/approvals.ts`
- Memory persistence: `src/adapters/vscodeMemoryStore.ts`
- Settings (getters incl. `getMaxOutputTokensPreference`): `src/adapters/vscodeConfig.ts`, `package.json` `contributes.configuration`
- UI: `media/main.js`, `src/ui/codeForgeViewProvider.ts`
- Roadmap design: `docs/hermes-roadmap.md`

## Known local endpoints
- `http://127.0.0.1:1234`, model `google/gemma-4-e4b` (LM Studio-style). Use for live smoke testing when running.
- LiteLLM proxy serving `gemma-4-31B-it` (and others) — the v0.1.12 truncation reports came from this setup. LiteLLM advertises each model's context length under `max_tokens` in `/v1/models` (now read as `contextLength`).

## Session notes for next agent
- Follow the ports-and-adapters boundaries; keep `src/core/*` testable without `vscode` imports (that is why `learning.ts`/`skillProposal.ts`/`agentProposal.ts`/`learningAudit.ts` are pure).
- New `src/core` logic should ship with a focused unit test; controller behavior with a harness integration test (`test/harness/agentControllerHarness.ts`, `ScriptedLlmProvider`, `FakeMemoryStore`).
- The harness defaults `learning.enabled` to **false** so existing tests are unaffected; opt in per-test via `learningSettings`.
- Run `npm run compile && npm run compile:tests && node --test out-test/test/unit/*.test.js out-test/test/integration/*.test.js` before handoff.
- Do not add public web tools, cloud presets, telemetry, CLI commands, or browser preview workflows.
- **v0.1.12 invariants — do not regress:** (a) keep raw malformed tool-call args in history and sanitize only at the outbound boundary (`toOpenAiMessage`) — never drop invalid calls from history; (b) `ask_user_question` always prompting in Full Auto is intentional, not a bug; (c) `max_tokens` is per-turn via `resolveRequestMaxTokens` — if you add a new `streamChat` call site, pass `maxTokens`; (d) LiteLLM `max_tokens` = context length, not output limit.
- Release flow: bump `package.json` + both `package-lock.json` entries, commit, then push an annotated `vX.Y.Z` tag (`CodeForge X.Y.Z — <summary>`). The `release-vsix.yml` workflow packages the VSIX and `gh release create`s on the tag push. Tags/commits are authored by Matthew Stroble only — no Co-Authored-By trailers.
