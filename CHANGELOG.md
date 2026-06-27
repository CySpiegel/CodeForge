# Changelog

All notable changes to CodeForge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor versions mark notable
maintenance/feature milestones, patch versions small fixes).

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
