# Hermes-likeness roadmap: multi sub-agents, learned agents, persona

Status of the learning work so far:
- **Done** — memory + skills learning loop (extraction, ranked injection, periodic audit, review UI), and **#2 sub-agent learning**: workers now receive the same prompt-ranked learned-lesson digest plus the bodies of the most relevant skills (`workerLearnedDigest` / `workerSkillsDigest` in `agentController.ts`, plumbed through `WorkerManagerOptions` → `ContextBuilder`).

This doc plans the next three steps. Each section is independently shippable.

---

## #1 — Parallel sub-agent orchestration + edit isolation (headline)

**Where we are.** CodeForge already has real sub-agents: `WorkerManager.spawn(kind, prompt)` runs a worker asynchronously with a restricted toolset; the model drives them via the `spawn_agent` and `worker_output` tools (`toolRegistry.ts`; `executeSpawnAgentAction` in `agentController.ts`). Built-in kinds: `explore / plan / review / verify / implement`, plus custom `.codeforge/agents/*.md`. `worker_output` already waits for completion, so a model *can* fan out (several `spawn_agent` calls) then read each back. What's missing is reliability and isolation.

**Goal.** Make "spawn several sub-agents in parallel and synthesize" a first-class, safe pattern.

**Design — do it in two slices:**

**1a. Reliable parallel read-only fan-out (low risk, most of the value).**
- Add a **concurrency cap** + queue in `WorkerManager` (config `codeforge.workers.maxConcurrent`, default ~3). Today nothing bounds simultaneous workers; a cap keeps local endpoints sane. Touch: `WorkerManager` (track running count, queue spawns, drain on `finish`).
- Add a batch **`spawn_agents`** tool (array of `{agent, prompt}`) that returns all worker ids, and a **`worker_join`** tool that waits for a set of workers and returns their summaries together — so the main agent gets a clean fan-in instead of polling one at a time. Touch: `toolRegistry.ts` (two tool defs + validation), `agentController.ts` (`executeSpawnAgentsAction`, `executeWorkerJoinAction`), reuse `WorkerManager.output`/`list`.
- Read-only kinds (`explore/plan/review/verify`) share the workspace safely — no isolation needed. This slice alone delivers parallel investigation/review, which is the common case.

**1b. Worktree isolation for parallel *editors* (higher risk, optional).**
- Problem: two `implement`/custom workers writing at once will clobber each other. Hermes "isolated subagents for parallel workstreams" ⇒ give each editing worker its own **git worktree**.
- Design: when an editing worker spawns under parallel mode, create a throwaway worktree (`git worktree add` in a temp dir), point that worker's file ops + `cwd` at it, and on success surface its diff back to the main tree **through the existing approval path** (so the user reviews the merge, consistent with CodeForge norms). On failure or no-change, remove the worktree (mirror the cleanup the harness already does for isolated agents).
- Touch: `WorkerManager` (per-task `cwd`/root override), a new `worktree.ts` adapter (create/remove/diff), `agentController` (route the merge diff into approvals). The diff/merge-back and conflict handling are the hard parts.

**Key decisions.**
- **Start with 1a; treat 1b as opt-in.** Most fan-out value is read-only; worktree merge-back is genuinely complex in an editor extension. Don't block the headline feature on it.
- **Cap concurrency** — unbounded parallel workers will overwhelm a single local model endpoint.
- Keep editing workers **serialized by default**; only isolate-and-parallelize when the user opts in.

**Tests.** Extend `workerManager.test.ts` for the concurrency cap (spawn N+2, assert ≤N run at once) and queue drain; integration test for `spawn_agents` + `worker_join` fan-in via the harness; (1b) a worktree adapter unit test with a temp git repo.

**Effort/risk.** 1a: medium / low. 1b: high / medium-high.

---

## #3 — Let learning propose & refine agent definitions

**Goal.** When a *kind of task* recurs (not just a procedure), propose a specialized sub-agent — the agent analogue of the skill proposal already shipped.

**Design.** Mirror `skillProposal.ts`:
- New `src/core/agentProposal.ts`: cluster recurring task types from learned lessons (by domain tokens/paths), and `renderAgentMarkdown()` emitting the `.codeforge/agents/<name>/AGENT.md` frontmatter `loadLocalAgents` already parses (`label`, `description`, `tools`, `max-turns` + system-prompt body).
- Controller `maybeProposeAgent()` alongside `maybeProposeSkill()`, gated by a new `codeforge.learning.agents.enabled`.
- Generalize the existing `pendingSkills` map into `pendingArtifacts` (skill | agent) so the **Learned** tab lists proposed agents with the same accept/reject flow. The `tools` list must be validated against the real tool registry so a learned agent can't grant itself capabilities it shouldn't have.

**Key decisions.**
- **Agents are review-only — never auto-write, even in `autonomy:"auto"`.** An agent definition grants autonomous behavior + a toolset; that's higher-stakes than a text lesson or a procedure skill. Always require explicit accept.
- Refining *existing* agent defs from feedback is a fast-follow; start with proposing new ones.

**Tests.** Unit for `agentProposal` (clustering, frontmatter renders → `loadLocalAgents` parses, tool-list sanitization); integration that a proposed agent appears in `pendingArtifacts` and writing it produces a loadable `AGENT.md` — never silently.

**Effort/risk.** Medium / medium (the tool-grant validation is the part to get right).

---

## #4 — Soul / persona pillar

**Goal.** A persistent, evolvable voice/identity — Hermes' `soul.md`.

**Design.**
- Load `.codeforge/soul.md` via `localExtensions.ts` (same markdown read as skills) and a user-global soul under the extension's global storage (cross-repo).
- Inject a **bounded** slice into the system prompt where `ensureSystemMessage`/`actionProtocol` build it, clearly fenced as persona guidance (not task instructions).
- Evolve it from feedback: a `soul`-scoped memory or a small "Persona" settings field; optionally let the learning loop emit `preference`-kind lessons that suggest soul edits (proposed, never auto-applied).

**Key decisions.**
- Persona shapes **tone**, never permissions or task behavior — keep it strictly additive to the system prompt and size-capped so it can't crowd out tools/context.
- One workspace soul + one user-global soul; workspace wins on overlap.

**Tests.** Unit that a soul file is loaded and bounded; a system-message assertion that persona text is present and capped. Extend `packageContract.test.ts` for any new keys.

**Effort/risk.** Low / low.

---

## #5 — Crons / scheduling (deferred — weak fit)

A VS Code extension has no background daemon, so Hermes-style unattended cron runs don't map cleanly. The closest existing surface is remote/scheduled agents at the harness level, not the extension. Recommend deferring; if pursued later, approximate with VS Code tasks or a "scheduled prompt" that only runs while the editor is open — low value relative to #1/#3/#4.

---

## Suggested order

1. **#1a** — parallel read-only fan-out + concurrency cap + `spawn_agents`/`worker_join` (the headline multi-agent capability, low risk).
2. **#4** — soul pillar (cheap, rounds out the 5 pillars).
3. **#3** — learned agent proposals (builds directly on shipped skill-proposal code).
4. **#1b** — worktree isolation for parallel editors (only if parallel *editing* becomes a real need).
5. **#5** — crons, only if a real scheduling need appears.
