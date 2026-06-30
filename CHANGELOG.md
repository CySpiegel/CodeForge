# Changelog

All notable changes to CodeForge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor versions mark notable
maintenance/feature milestones, patch versions small fixes).

## [0.3.0] - 2026-06-30

Automatic context-window management: the context budget now follows the model you select — reflected in
the context ring, its hover tooltip, and the compaction threshold — with a settings selector for the
model used to compact context. Also fixes the settings tabs being unclickable in a narrow panel.

### Added
- **The context window now follows the selected model automatically.** Picking a model from the
  front-page dropdown re-inspects `/v1/models` and applies that model's discovered context length to
  the context ring, its hover tooltip, and the auto-compaction threshold — no need to type a value into
  the settings "Context window tokens" field. Switching to a larger-context model raises the budget;
  switching to a smaller-context model lowers it and, when the live context no longer fits, triggers an
  automatic compaction so the next turn does not overflow. An explicit `maxTokens` override still wins
  when set.
- **Context-compaction model selector in Settings.** The settings panel now has a "Context-compaction
  model" dropdown listing the endpoint's available models (plus "Use the selected model"), wired to
  `codeforge.model.auxiliary` — the smaller/faster model CodeForge uses for its own background turns
  (context compaction, the learning review, curator). Previously this was settings-file-only. This also
  lets a drastic downshift compact with a capable model instead of the tiny model just selected.

### Fixed
- **Switching models no longer keeps a stale context budget.** Previously the context window was
  resolved from the inspection cached at connect time, so changing models left the budget on whatever
  was loaded first; a model whose context was unknown in that cache fell back to the 120000-byte
  (≈30000-token) default and compacted early. Model selection now re-fetches `/v1/models` and re-resolves
  the active model's context length.
- **Settings tabs are clickable again in a narrow/short panel.** The settings modal's `.settings-surface`
  is a CSS grid with four children (header, tabs, content, actions) but declared only three rows
  (`grid-template-rows: auto minmax(0, 1fr) auto`), so the flexible/scrolling track landed on the **tabs**
  row instead of the content pane. When the surface was height-constrained — the default VS Code sidebar,
  made worse by the single-column `@media (max-width: 520px)` layout and by display scaling on Windows /
  Remote-WSL — the tabs row collapsed toward `0px`; its buttons stayed visible but were overlapped by the
  transparent content pane, which won the hit-test and swallowed the clicks (Endpoint/MCP/Permissions/
  Memory/Inspector all looked present but did nothing). The grid now declares one row per child
  (`auto auto minmax(0, 1fr) auto`) so the content pane is the scrolling track and the tabs row can no
  longer collapse. This was a layout bug on every deployment, not Windows-specific. A `settingsLayout`
  contract test pins the track-count/child-count invariant so the off-by-one cannot silently return.

## [0.2.1] - 2026-06-26

Reliability release focused on imperfect local-model output — truncated streams and slightly-off
diffs — plus making the learning loop visible.

### Added
- **`codeforge.review.verbosity`** (`verbose` | `concise` | `status` | `silent`, default `verbose`) —
  controls how visibly the background self-improvement (learning) review reports itself in chat. The
  review now shows a transient `🧠 Reviewing this session…` status and a result line every run (a save
  notice, `🧠 Reviewed — nothing new`, or `🧠 Couldn't review`), so it is no longer invisible when it
  saves nothing. Learning still runs regardless of the setting.

### Fixed
- **Truncated tool-call arguments no longer break a tool.** A tool call's `arguments` is not guaranteed
  to be valid JSON and local models routinely truncate it mid-string ("Unterminated string in JSON at
  position N"). Inbound parsing now repairs the partial JSON or returns a clear, retryable instruction
  instead of a raw error — on the main loop, the MCP branch, and workers. The non-native JSON
  action-protocol path and the background review/curator parsing are repaired the same way (previously
  they silently dropped a truncated action or learned lesson).
- **A malformed SSE frame no longer kills the stream.** The streaming parser guards its `JSON.parse`,
  so a partial or garbled frame — e.g. flushed after a dropped or quiet-cancelled stream — is skipped
  instead of throwing a raw position-N error out of the turn and discarding accumulated output.
- **Patches apply by searching for context instead of trusting line numbers.** The unified-diff applier
  ("Patch does not apply … near hunk starting at line N") now locates each hunk by its context/removed
  lines, tolerates trailing/leading whitespace differences, preserves the file's original line endings
  (no more silent CRLF→LF rewrite), and on genuine failure returns actionable guidance. The parser also
  tolerates a missing `+++` header, a context line that lost its leading space, and loose `@@` headers.

## [0.2.0] - 2026-06-12

Internal architecture milestone — no user-facing behavior change. Every refactor below is
behavior-preserving and was landed with the full offline test suite green.

### Changed
- **Modular decomposition of the large files**, applying "one module, one responsibility":
  - `src/core/toolRegistry.ts` **1,851 → 102 lines**: shared input validators moved to
    `toolValidation.ts`, pure action-classification predicates to `toolClassification.ts`, and the
    36-tool table split into 10 per-domain modules under `src/core/tools/*`, composed by spread.
  - `src/agent/agentController.ts` **2,405 → 2,277 lines**: approval display formatting →
    `approvalMetadata.ts`; per-request tool-list assembly → `toolRequestDefinitions.ts`.
  - `media/main.js` **2,844 → 1,560 lines**: the webview is now a set of focused `window.CodeForge`
    modules (`markdown.js`, `dom.js`, `inspector.js`, `approvals.js`, `mcpEditor.js`, `workerList.js`,
    `slashCommands.js`) loaded before `main.js`; the message-bridge core stays in `main.js`.
- Session writes are atomic (temp file + rename) so a crash mid-write can never truncate a session.
- Webview nonce uses `crypto.randomBytes` instead of `Math.random`.

### Added
- Direct unit tests for the newly-extracted pure modules (`toolValidation`, `toolClassification`,
  `approvalMetadata`, `toolRequestDefinitions`); suite is now 300 tests.
- Live smoke harness `test/smoke/liveWorkerSmoke.ts` exercising parallel sub-agent execution against a
  real endpoint (env-driven; not part of `npm test`).
- CI workflow (`.github/workflows/ci.yml`): compile + full test suite on every push/PR.
- `package.json` `repository`, `bugs`, and `homepage` metadata.
- Minimal ESLint (`eslint.config.mjs`) + a `lint` script wired into CI.
- A comprehensive **user guide** (`docs/user-guide.md`): endpoint setup, working/approval modes, the
  full command surface, context management for local models, sub-agents, memory, `.codeforge/`
  customization, MCP, local-model tips, and troubleshooting. Linked from the README.

### Fixed
- Documentation reconciled with the current code. Corrected stale references to the replaced learning
  system across the README, `ARCHITECTURE.md`, `docs/testing.md`, and `docs/local-extensions.md` — there is
  no "Learned" accept/reject panel, no `learning.autonomy` setting, no `memory_write` tool, and no learned
  "lessons" or agent proposals; the background review writes memory and skills directly (anti-poisoning
  gated). Also fixed the deterministic test count (300) and the webview module list.

## [0.1.15] and earlier

See `git` history and `HANDOFF.md` for the learning loop, multi-agent workers, context-length detection,
and the `agentController.ts` decomposition phases that preceded this release.
