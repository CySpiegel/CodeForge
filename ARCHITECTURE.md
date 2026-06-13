# CodeForge Architecture

CodeForge uses a ports-and-adapters layout so the coding harness stays testable and self-hosted endpoint support remains first class.

## Boundaries

- `src/core`: provider contracts, network policy, SSE parsing, context budgeting, local memory contracts, action parsing, approval state, and patch parsing. This layer has no VS Code imports.
  - Learning/curation core (`curator.ts`, `backgroundReview.ts`): the deterministic skill-library lifecycle sweep plus the LLM umbrella-consolidation pass, and the self-review prompt builder over `MemoryEntry`/skill state. No VS Code imports — the agent layer (`learningCoordinator.ts`, `learningReview.ts`) orchestrates the model calls and file writes.
  - Sub-agent definitions (`workerAgents.ts`, `workerTypes.ts`): the built-in worker kinds (`explore`, `plan`, `review`, `verify`, `implement`) with their bounded toolsets, plus `custom` for `.codeforge/agents` definitions. No VS Code imports.
  - Persona/voice loading lives in `localExtensions.ts` (`loadLocalSoul`, alongside the loaders for local commands, skills, and agents).
  - Tool registry (`toolRegistry.ts`): a thin composition root that spreads the per-domain tool tables from `core/tools/*` (`readTools`, `editTools`, `commandTools`, `codeIntelTools`, `taskTools`, `notebookTools`, `mcpTools`, `memoryTools`, `workerTools`, `interactionTools`) into `codeForgeTools`, plus the derived exports (`findTool`/`parseAction`/`validateAction`/`toolSummary`) and the table-coupled predicates. Shared input validators live in `toolValidation.ts`; the pure action-classification predicates in `toolClassification.ts`. Category modules use `import type { CodeForgeTool }` to avoid a runtime cycle.
- `src/adapters`: VS Code, filesystem, terminal, configuration, secrets, local memory/session storage, and diff-preview adapters. `worktree.ts` (`GitWorktreeManager`) is a Git worktree isolation adapter for parallel editing sub-agents — built and tested, but not yet wired into the worker runtime.
- `src/agent`: orchestration of prompts, local context, endpoint calls, local tool loops, approvals, and execution. `workerManager.ts` runs sub-agents under a concurrency cap (`codeforge.workers.maxConcurrent`, default 3) with a start-as-others-finish queue, and is lesson/skill-aware so workers inherit relevant learned context.
- `src/ui`: VS Code sidebar view provider and message bridge.
- `media`: the VS Code extension-view (webview) JavaScript, CSS, and icon assets. The view is split into focused, single-responsibility scripts that share a `window.CodeForge` namespace (see "Webview modules" below) rather than one monolith.

## Patterns

- Adapter pattern: self-hosted LLM endpoints, VS Code workspace APIs, terminal execution, and diff previews are isolated behind small interfaces.
- Strategy pattern: endpoint behavior, context collection, and native-tool-call versus JSON-action fallback can evolve without changing UI code.
- Command pattern: model-requested actions are represented as typed command records before execution.
- State machine discipline: sessions move through prompt, streaming, local tool, approval, execution, and idle/error states explicitly.
- Event sourcing: sessions persist append-only JSONL records for messages, approvals, checkpoints, and resumable transcript replay.
- Dependency injection: `extension.ts` is the composition root; core modules do not reach into global VS Code state.

## Webview modules

`media/` has no bundler and runs under a strict-nonce CSP (`script-src 'nonce-…'`, `default-src 'none'`), so the view is decomposed into separate `<script nonce>` files emitted in dependency order by `codeForgeViewProvider.ts`'s `html()`. Each script is its own IIFE; they share state only through a single `window.CodeForge` global, and `main.js` (loaded last) pulls the helpers in at the top of its IIFE so existing call sites stay unchanged. Two composition shapes are used:

- **Pure leaves** expose a function directly (e.g. `window.CodeForge.renderMarkdown`): `markdown.js` (markdown→DOM + syntax highlight), `dom.js` (stateless DOM/format/string helpers), `inspector.js` (run-event/audit list rendering).
- **Stateful/host-coupled sub-components** expose a `create…(deps)` factory that the view calls once with its live references (`vscode`, the `elements` map, a live `getState`, injected callbacks/helpers): `approvals.js` (`createApprovals`), `mcpEditor.js` (`createMcpEditor` — owns the MCP server-draft state), `workerList.js` (`createWorkerList`), `slashCommands.js` (`createSlashCommands` — the `/command` + `/models` autocomplete menu; model selection itself stays in `main.js` and is passed in via `onSelectModel`).

Load order is `markdown → dom → inspector → approvals → mcpEditor → workerList → slashCommands → main`. `main.js` retains the cohesive core: webview state, the extension↔view message bridge, the menu/picker system, context-usage display, the chat-coupled session list, and event wiring. New view features should follow the same rule — extract a separable concern into its own `window.CodeForge` module (pure leaf if stateless, factory if it needs host state) rather than growing `main.js`. There is no build step for `media/`; validate with `node --check media/<file>.js`.

## Design Rules

- No Claude Code source is copied into this project.
- Runtime dependencies are avoided unless they remove real complexity.
- Public IP network access is blocked. CodeForge permits localhost, private IP ranges, and explicitly configured on-prem hostnames for vLLM/LiteLLM-compatible endpoints.
- File writes and shell commands require user approval.
- Shell commands run through the terminal adapter with workspace-scoped cwd validation, bounded output, cancellation, and a minimized environment.
- Local memory is written only through the `memory` tool and the user's `/memory` command, gated by `codeforge.memory.enabled`; nothing else writes to memory.
- Model responses and local action requests are parsed through typed, validated boundaries before use.
- The learning loop is fire-and-forget and fully guarded: it runs only after a finished task and must never block or break a run.
- Skills under `.codeforge/skills` are written by the background self-improvement review via the `skill_manage` tool (gated by `codeforge.skills.enabled`), not the user-approval path; the guard is an anti-poisoning check that blocks a skill write after a failed run.
- Worker agent definitions are never written or proposed by CodeForge — `.codeforge/agents` files are authored only by you.
