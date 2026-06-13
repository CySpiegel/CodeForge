# Changelog

All notable changes to CodeForge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor versions mark notable
maintenance/feature milestones, patch versions small fixes).

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
