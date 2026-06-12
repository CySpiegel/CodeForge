# CodeForge Handoff

Last updated: 2026-06-12

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

## Current State (v0.1.15)

Core product (Phases 0–11) is unchanged and described in the git history. Several recent bodies of work sit on top:

1. **Approval-continuation fix** (v0.0.10): after approving an edit/command in Smart/Manual modes the loop continues. Root cause was a `tool → user` adjacency injected into the post-approval request that local chat templates mis-render; the fix re-requests the transcript ending in the tool result (matching the working Full-Auto path) and folds the "keep going" guidance into the tool result. See `agentController.ts` `runModelLoop` / `approve`.

2. **Hermes-style learning + multi sub-agent system** (v0.1.11) — described below.

3. **Tool-call reliability + output-token control** (v0.1.12) — described below.

4. **Visible learning + Learned-panel fix** (v0.1.13) — described below.

5. **Context-length detection + startup model selection** (v0.1.14) — described below.

6. **agentController.ts decomposition** (this session, post-v0.1.15) — pure structural refactor, described next.

**Tests: 283 pass / 0 fail.** `tsc` clean, extension compiles. Run:
```bash
npm run compile && npm run compile:tests && node --test out-test/test/unit/*.test.js out-test/test/integration/*.test.js
```

## agentController.ts decomposition (this session — structural, behavior-preserving)

Goal (user directive): "one function does one thing", "we should never be doing huge monolithic code files", proper design patterns. `agentController.ts` went from **5,763 → 2,416 lines (≈58%)** by lifting every *separable* concern into its own SRP module, while the **run engine stays cohesive** (run loop, tool execution, approval flow, streaming, system-message/context wiring, collaborator orchestration). No behavior change — verified by three adversarial workflows (byte-level diffs vs the pre-refactor controller) reporting **zero regressions**, plus the full suite green at every commit (206 → 283 tests). **The decomposition is complete: every candidate from the analysis passes is extracted.**

**Extraction pattern (follow it for any future split):** each module declares an `XxxDeps`/host interface; the controller constructs it with arrow closures bound to its own methods/state (same DI shape as the pre-existing `WorkerManager`/`SessionService`/`ContextManager`). Type-only cross-imports use `import type`. Backward-compatible test imports preserved via re-export (e.g. `export { isContextOverflowError } from "./toolText"`). A *wide* interface on a top-level dispatcher (the slash router) is inherent, not a smell — do not force-split a cohesive flow just to shrink an interface.

**Round 1 modules (commits `f0155f4`..`0731c89`):**
- `src/agent/slashCommandRouter.ts` (673) — the entire `/command` surface: parse + dispatch + all report/list builders. `SlashCommandHost` is intentionally wide.
- `src/core/toolDiscovery.ts` (231+) — pure tool discovery + schema search + `parseNativeToolCall` + markers/`readOnlyToolNames`/`coreAgentToolNames`/`coreReadOnlyToolNames`/`McpToolBinding`/`ToolSchemaSearchResult`. Core (no `vscode`), shared by the run engine. Unit-tested.
- `src/agent/taskBoard.ts` (131) — model-facing task board (task_create/update/list/get) + session persist/restore. `getState` does **not** project tasks. Unit-tested.
- `src/agent/undoManager.ts` (119) — undo snapshot stack + `/undo` restore. Public `AgentController.undo()` delegate kept for the view provider.
- `src/agent/approvalText.ts` (118) — pure approval presentation builders (incl. the exhaustive `approvalAcceptedText` switch).
- `src/agent/providerGateway.ts` (79) — provider construction + per-(profile,model) capability probe/cache.
- `src/agent/inspectorLog.ts` (73) — run-inspector + permission-audit ring buffers and the `inspector` UI event.
- `src/agent/commandResultText.ts` (37) — command/hook result rendering.
- **Consolidated into existing cohesive homes (not a new junk-drawer module):** error-classification helpers (`isContextOverflowError`, `isRecoverableEditPreflightError`, `modelRecoverableToolError`, `isMissingFileError`, `isRecord`) → `src/agent/toolText.ts`; action-visibility predicates (`isInternal{Automation,State,Read}Action`) → `src/core/toolRegistry.ts` beside the other action predicates.

**Round 2+3 modules (commits `a9c95cc`..`25d0ee7`):**
- `src/agent/spawnAgentService.ts` (~190) — `spawn_agent` impl: worker launch + the local-agent→worker-definition mapping (12 capability tool-name consts). Constructed **after** WorkerManager (holds a direct `this.workers` ref).
- `src/agent/toolSchemaService.ts` (~115) — `tool_list` / `tool_search` impl (catalog + CodeForge/MCP schema search). Dispatcher delegates.
- `src/agent/taskBoard.ts`, `toolSchemaService.ts`, `spawnAgentService.ts` follow the same precedent: **move a tool's implementation out, the `executePermittedAction` dispatcher just delegates** — this is *not* splitting the run engine.
- `src/agent/localHookRunner.ts` (~70) — pre/post/failure local shell-hook execution (~26 dispatcher call sites delegate to `localHooks.run`).
- `src/agent/readStateTracker.ts` (~60) — **pure, Deps-free** state store behind the stale-read guard (read-file snapshots + read-notebook set, path-normalized). The guard logic (`preflightWritableAction`) and file I/O (`readWorkspaceFileIfExists`) **stay** in the controller and call the tracker. Unit-tested.
- `src/agent/memoryCommands.ts` (~90) — curated-memory CRUD + summary (sole owner of the raw `MemoryStore`; distinct from the tool-facing `MemoryManager`). 4 public delegates kept for the view provider/tests.
- `src/agent/pinnedFiles.ts` (~65) — pinned-context-file set + `/pin` surface. 3 public delegates kept.
- `src/agent/systemPrompt.ts` (~75) — `SystemPromptBuilder.build()` + `agentModeLabel` + mode-instruction prose. `ensureSystemMessage` (in-place message-log updater) stays.
- `src/agent/changeVerifier.ts` (~50) — post-edit diagnostics "Verification:" footer.

This builds on the earlier decomposition phases (also in git history): `sessionService.ts`, `contextManager.ts`, `modelResolver.ts`, `mcpCoordinator.ts`, `doctorService.ts`, `learningCoordinator.ts`, `learningReview.ts`, `modelStream.ts`, `agentUiTypes.ts`, `core/git.ts` + `gitTool.ts`. The controller is now a thin orchestrator over ~30 focused modules. What remains in it is intentional: the run loop, tool dispatch, approval flow, streaming, session lifecycle, the constructor DI assembly, and thin public delegates for the view provider. **`ReadStateTracker` was the final candidate** — extracted as a pure state container while its correctness-critical stale-read guard logic stayed in the controller.

**Two near-misses caught by verification (already fixed before their commits):** (1) the view provider calls `controller.undo()` directly — the full-project typecheck caught it; preserved via a thin public delegate. (2) a hand-written `formatTask` in `taskBoard.ts` diverged from the original (`Active:` vs `Active form:`, `toISOString` vs `toLocaleString`, the metadata key-count guard) — corrected to byte-match. **Lesson: when re-typing a moved body, diff it against `git show <base>:<file>` rather than trusting memory.**

**Follow-up (low priority, not done):** `src/agent/workerManager.ts` keeps its own copies of `codeForgeToolSchemaMarker` + `escapeRegExp` + an inline schema-marker discovery regex; these could now import from `core/toolDiscovery.ts` to de-duplicate.

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
- `learning.enabled` (true), `learning.autonomy` (review|hybrid|auto, default hybrid), `learning.scope` (split|repo|global, default split)
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

## Learning visibility + Learned-panel fix (v0.1.13, shipped)

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

Note: the exact dead-button cause could not be reproduced by static analysis (controller logic is correct + test-covered); the optimistic webview update both hardens the untested layer and gives instant feedback. If buttons still feel dead in the live extension, check the webview Developer Tools console for an exception thrown inside `renderState()` before `renderLearned()` runs.

## Context-length detection + startup model selection (v0.1.14)

Two robustness fixes in endpoint inspection + model selection, both in `src/core/openaiAdapter.ts` and `src/agent/agentController.ts`. Shipped as v0.1.14 (commit `b2d1d73`, tag `v0.1.14`).

### Robust context-length detection (`/v1/models`)
`modelsFromBody` → `findPositiveInteger` now detects a model's context window across many more backend-specific fields and ignores junk values:
- **More fields recognized:** added `n_ctx_train` (llama.cpp trained max, often the only signal on older `llama-server` builds), `loaded_context_length`/`loadedContextLength` (LM Studio runtime allocated window), `n_positions` (older HF / GPT-2 family), and `model_max_length` (HF tokenizer config). These join the existing `max_model_len`, `n_ctx`, `context_length`, `context_window`, `max_seq_len`, `max_position_embeddings`, LiteLLM's `max_input_tokens`/`max_tokens`, etc.
- **Runtime window ranked ahead of model-max:** keys are tried in priority order so the *loaded/runtime* window (what the server will actually accept right now) beats the model's trained/architectural maximum when both are present. `n_ctx_train` sits below the live `n_ctx` for the same reason.
- **Priority-first nested search:** `findPositiveInteger` searches the whole model object (incl. nested `meta`/`model_info`/`parameters`) for each key in turn — so a higher-priority field nested anywhere beats a lower-priority field at the top level (e.g. a nested context field beats a top-level LiteLLM `max_tokens`). PRIORITY DOMINATES NESTING DEPTH.
- **Array-descent stop:** `deepFindInteger` descends only into plain objects (`isPlainObject`), never into arrays — so a stray integer inside a `permissions`/limits list can't be mistaken for a context window. Depth is capped at 4.
- **Sanity bounds:** detected values must satisfy `MIN_CONTEXT_LENGTH = 256` ≤ v ≤ `MAX_CONTEXT_LENGTH = 100_000_000` (`{ minValue, maxValue }` passed to `findPositiveInteger`). This rejects stray small ints (a permission `max_tokens: 1`, `n_parallel`, batch sizes) and the HuggingFace ~1e30 "unbounded" sentinel that `model_max_length` can carry.

### Alias-aware startup model selection
`resolveConfiguredModelId(configured, models)` (exported from `agentController.ts`, unit-tested) deterministically resolves the persisted/configured model id against the endpoint's returned models:
- **Alias-aware, tolerant match:** matches the configured id against each model's canonical `id` **and** its `aliases`, trimmed and case-insensitively, and returns the **canonical** returned id on a match.
- **Unmatched id is kept, not swapped:** a non-empty configured id that matches nothing is **kept** (flagged `unmatched`, surfacing one deduplicated inspector warning via `warnUnmatchedConfiguredModel`) instead of being silently swapped to `models[0]`. This guarantees the model the user intends is the model actually sent — important for single-model servers (llama.cpp) that ignore the requested id and serve their loaded model anyway. An empty configured id still falls back to `models[0]` (prior behavior).
- **Aliases captured into `ModelInfo`:** `modelsFromBody` reads `data[].aliases` (via `toStringArray`) into `ModelInfo.aliases` and the capability cache, so the dropdown and the matcher see them.
- **Per-profile seeding:** `selectedModelFor` resolves and seeds `selectedModelByProfile` after the first inspection, so the model shown in the UI and the model actually sent agree from turn one.

New test: `test/unit/modelSelection.test.ts` (exact match, case/whitespace-insensitive match, alias match, empty→`models[0]`, whitespace-only→`models[0]`, unmatched non-empty kept+flagged, empty model list cases).

## Tool-call reliability + output-token control (v0.1.12)

Local models (e.g. `gemma-4-31B-it` served via LiteLLM) truncate tool-call arguments mid-string. A multi-agent diagnosis (4 parallel investigators + adversarial verifiers + synthesis) traced **one root cause behind three reported symptoms**, plus a latent model-metadata bug. All fixed and shipped as v0.1.12 (commit `781616e`, tag `v0.1.12`).

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
- Orchestration / run engine (run loop, tool execution, approval flow, streaming, system message, collaborator wiring): `src/agent/agentController.ts` — now a thin orchestrator; separable concerns live in the modules below.
- Slash commands: `src/agent/slashCommandRouter.ts`
- Tool discovery + schema search + native-call parse: `src/core/toolDiscovery.ts`
- Task board: `src/agent/taskBoard.ts` · Undo: `src/agent/undoManager.ts` · Provider/capability gateway: `src/agent/providerGateway.ts` · Inspector/audit buffers: `src/agent/inspectorLog.ts`
- Approval presentation: `src/agent/approvalText.ts` · Command-result text: `src/agent/commandResultText.ts` · Tool-error text/classification: `src/agent/toolText.ts`
- Session/context/model/MCP/doctor/learning collaborators: `src/agent/{sessionService,contextManager,modelResolver,mcpCoordinator,doctorService,learningCoordinator}.ts`
- Sub-agents: `src/agent/workerManager.ts`, `src/core/workerAgents.ts`
- Learning core: `src/core/learning.ts`, `skillProposal.ts`, `agentProposal.ts`, `learningAudit.ts`
- Worktree adapter: `src/adapters/worktree.ts`
- Context assembly: `src/core/contextBuilder.ts`
- Tools: `src/core/toolRegistry.ts`
- Endpoint / streaming / model discovery / context-length detection (`findPositiveInteger`) / `max_tokens` / tool-arg sanitize: `src/core/openaiAdapter.ts`
- Startup model selection (`resolveConfiguredModelId`, alias-aware): `src/agent/agentController.ts`; covered by `test/unit/modelSelection.test.ts`
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
- **Decomposition invariants — do not regress:** keep the **run engine cohesive** in `agentController.ts` (don't force-split the run loop / tool execution / approval flow / streaming). Any *new* separable concern gets its own module via an `XxxDeps`/host interface with controller-bound closures (the established pattern). When relocating an existing function, move it **byte-faithfully** — diff against `git show <base>:src/agent/agentController.ts`, don't retype from memory. Prefer placing a stray helper in a cohesive existing home (e.g. tool-error helpers → `toolText.ts`, action predicates → `core/toolRegistry.ts`) over creating a catch-all "misc" module.
- Follow the ports-and-adapters boundaries; keep `src/core/*` testable without `vscode` imports (that is why `learning.ts`/`skillProposal.ts`/`agentProposal.ts`/`learningAudit.ts`/`toolDiscovery.ts` are pure).
- New `src/core` logic should ship with a focused unit test; controller behavior with a harness integration test (`test/harness/agentControllerHarness.ts`, `ScriptedLlmProvider`, `FakeMemoryStore`).
- The harness defaults `learning.enabled` to **false** so existing tests are unaffected; opt in per-test via `learningSettings`.
- Run `npm run compile && npm run compile:tests && node --test out-test/test/unit/*.test.js out-test/test/integration/*.test.js` before handoff.
- Do not add public web tools, cloud presets, telemetry, CLI commands, or browser preview workflows.
- **v0.1.12 invariants — do not regress:** (a) keep raw malformed tool-call args in history and sanitize only at the outbound boundary (`toOpenAiMessage`) — never drop invalid calls from history; (b) `ask_user_question` always prompting in Full Auto is intentional, not a bug; (c) `max_tokens` is per-turn via `resolveRequestMaxTokens` — if you add a new `streamChat` call site, pass `maxTokens`; (d) LiteLLM `max_tokens` = context length, not output limit.
- **v0.1.14 invariants — do not regress:** (a) context-length detection is priority-first across nesting with sanity bounds `256 ≤ v ≤ 1e8` — keep arrays out of the deep search (`isPlainObject`) so stray ints / the HF ~1e30 sentinel can't slip in, and keep runtime/loaded fields ranked ahead of model-max; (b) `resolveConfiguredModelId` keeps a non-empty unmatched configured id (warn once) and never silently swaps it to `models[0]`; only an empty id falls back to `models[0]`.
- Release flow: bump `package.json` + both `package-lock.json` entries, commit, then push an annotated `vX.Y.Z` tag (`CodeForge X.Y.Z — <summary>`). The `release-vsix.yml` workflow packages the VSIX and `gh release create`s on the tag push. Tags/commits are authored by Matthew Stroble only — no Co-Authored-By trailers.
