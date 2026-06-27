# CodeForge Testing

CodeForge is a VS Code extension-only local coding harness. Tests should verify the internal tool pipeline first, then the VS Code host, then optional live local endpoint behavior.

## Standard Suite

Run this before committing code changes:

```bash
npm test
```

This compiles the test project and runs the full deterministic suite (currently **327 tests pass / 0 fail**), covering:

- core unit tests
- tool registry validation tests, plus the extracted validator/classification/approval-metadata/request-tooling unit tests (`toolValidation.ts`, `toolClassification.ts`, `approvalMetadata.ts`, `toolRequestDefinitions.ts`)
- permission matrix tests
- settings and session migration tests
- `/doctor` report tests
- offline workspace index tests
- pinned active-file context, run inspector, permission audit, edit verification, and memory-management integration tests
- package contract checks for VS Code-only/offline-first release shape
- MCP client tests
- background self-improvement review tests (`backgroundReview.ts`) and curator tests (`curator.ts`, `curatorBackup.ts`: deterministic active → stale → archived transitions, recoverable backups, pinned-exempt archiving)
- skill manager and skill-usage tests (`skillManager.ts`, `skillUsage.ts`, `skillIo.ts`: agent-built skill create/patch/view, `SKILL.md` rendering the loader can parse, `.usage.json` tracking, tool validation against the real registry)
- worker manager tests (read-only vs approval-gated dispatch, per-kind tool gating, native tool-call parse-error retries, ranked relevant-skill context, and the `workers.maxConcurrent` concurrency cap) plus built-in worker agent tests (`workerAgents.ts`)
- worktree adapter tests (`GitWorktreeManager` isolating edits in a throwaway worktree and capturing a diff, plus `isAvailable` outside a git repo)
- model-selection tests (`modelSelection.test.ts`, covering `resolveConfiguredModelId` in `agentController.ts`: alias/canonical-id matching, case/whitespace tolerance, unmatched non-empty id kept rather than swapped to `models[0]`)
- `openaiAdapter` tests (tool-argument sanitize/repair, `resolveRequestMaxTokens` bounding, and context-length detection across LiteLLM, llama.cpp `n_ctx`/`n_ctx_train`, LM Studio `loaded_context_length`, and nested fields)
- deterministic `AgentController` pipeline integration tests

The integration harness uses a scripted in-memory LLM provider and fake workspace, diff, terminal, code-intel, notebook, memory, and MCP adapters. It tests CodeForge orchestration without relying on a live model.

## Production Compile

Run this before launching or packaging:

```bash
npm run compile
```

Check the webview script syntax when UI files changed (the view is split into `window.CodeForge` modules):

```bash
node --check media/*.js
```

## VS Code Extension Host

Run this before phase handoffs or packaging checks:

```bash
npm run vscode:test
```

This launches the VS Code extension host and catches activation, contributed command registration, default configuration, packaging, and VS Code API integration failures that unit tests cannot catch.

## Optional Live Local Endpoint Smoke

Use this only when a local OpenAI-compatible endpoint is running. Defaults used during Phase 9 hardening:

```bash
CODEFORGE_SMOKE_BASE_URL=http://127.0.0.1:1234
CODEFORGE_SMOKE_MODEL=google/gemma-4-e4b
```

The smoke should verify:

- model discovery succeeds
- native OpenAI tool schemas are accepted
- Ask mode executes a read-only workspace tool
- Plan mode executes read-only workspace tools and does not write
- Agent mode executes a write tool through the controller/diff path

## Manual UI Pass

After `npm run compile`, launch the extension in a development host and check:

- settings modal opens from the top-right settings icon
- endpoint profile can be added, selected, edited, and deleted from the UI
- model selector lists models from the active endpoint
- mode selector switches Agent, Ask, and Plan
- slash command menu opens, scrolls, and selects commands
- chat input sends on Enter and expands while typing
- markdown and code highlighting render in assistant messages
- context indicator tooltip shows exact token usage and compaction affordance
- active file can be pinned and cleared from the composer status row
- `/index` reports an offline workspace map with important files, diagnostics, symbols, and imports
- run inspector panel shows model/tool/verification events and permission audit history
- memory settings can add, edit, delete, and clear local memories
- `/skills` and `/skill` list and inspect the agent-built local skills under `.codeforge/skills`, and `/curator` reports the skill-library consolidation/archive status
- `/workers` and `/worker` list and inspect spawned sub-agents (and the built-in kinds), and `/agents` lists the local custom worker agents defined under `.codeforge/agents/`
- after an Agent-mode task, the background review may save memory or author/refine a skill, surfaced through `/memory` and `/skills`
- model metadata shows cached capability status after `/doctor` or a model request
- MCP settings can add, inspect, and delete servers
- `/doctor` reports local endpoint, model, workspace, permission, MCP, persistence, and tooling status
- Ask can inspect the repo
- Plan can inspect the repo and stays read-only
- Agent can write a test file through the configured approval mode

## Phase 10 Acceptance Criteria

Phase 10 should not be considered complete until:

- a fresh extension-development install can configure a local OpenAI-compatible endpoint from the UI
- Ask, Plan, and Agent workflows pass against a live local endpoint
- `/doctor` reports endpoint, model capability, network policy, workspace, and permission status
- settings/session migrations are covered by tests
- release packaging checks pass without telemetry, cloud presets, web fetch/search, browser preview, or CLI surfaces
- regressions in the deterministic `AgentController` pipeline suite block completion
