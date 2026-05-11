# CodeForge Handoff

Last updated: 2026-05-11

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

## Current State

The roadmap is implemented through Phase 11:

- Phase 0-7: core tool loop, permissions, VS Code file/search/edit flows, sessions, memory, shell execution, UI, and local extension points.
- Phase 8: local/on-prem MCP configuration, validation, resource attachment, and tool calls.
- Phase 9/9B/9C: worker agents, model-facing internal tools, deferred tool schema loading, invalid tool-call recovery, concurrency-safe tool batching, and concrete MCP tool schemas.
- Phase 10: `/doctor`, settings/session migrations, package contract tests, extension-host checks, and release guardrails.
- Phase 11: offline workspace index, pinned context files, run inspector, permission audit, post-edit diagnostics verification, in-app memory management, and persisted endpoint capability cache.

The repo was clean before this handoff file was added.

## Key Features To Know

- Endpoint abstraction is shown as **OpenAI API** only. LiteLLM, vLLM, and LM Studio are treated as transparent OpenAI-compatible backends.
- `/v1/models` discovery feeds model list, context length, output token metadata, and reasoning-model indicators when exposed by the server.
- Model capability probing detects native OpenAI tool-call support and caches capability results in VS Code global storage.
- Ask and Plan modes are read-only for side effects; Agent mode can edit, run approved commands, and iterate.
- Slash commands include `/doctor`, `/index`, `/pin`, `/unpin`, `/pins`, `/inspect`, `/audit`, `/capabilities`, `/models`, `/memory`, `/mcp`, `/workers`, `/agent`, `/ask`, and `/plan`.
- Context includes project instructions, explicit memories, MCP resources, pinned files, active/open files, an offline workspace index, and a file list.
- After file edits, CodeForge checks VS Code diagnostics for changed files and returns those diagnostics to the model.
- The run inspector surfaces tool execution, context attachment, endpoint probes, approvals, verification events, and permission audit history.

## Important Files

- `src/agent/agentController.ts`: main orchestration, slash commands, tool loop, approvals, `/doctor`, inspector/audit, pinned context, memory UI APIs, edit verification, capability caching.
- `src/core/toolRegistry.ts`: model-facing internal tool definitions, validation, summaries, risk metadata.
- `src/core/workspaceIndex.ts`: offline codebase index builder.
- `src/core/contextBuilder.ts`: context assembly and pinned/index attachment.
- `src/core/endpointCapabilityCache.ts`: capability cache contracts.
- `src/adapters/vscodeEndpointCapabilityStore.ts`: VS Code global-state capability cache adapter.
- `src/adapters/vscodeMemoryStore.ts`: local memory persistence and update support.
- `src/ui/codeForgeViewProvider.ts`: VS Code webview bridge and settings panel message handling.
- `media/main.js`: extension UI behavior.
- `media/styles.css`: extension UI styles.
- `docs/roadmap.md`: current phase status.
- `docs/testing.md`: verification checklist.
- `README.md`: user-facing explanation.

## Verification Already Run

These passed after Phase 11 implementation:

```bash
npm test
npm run compile
node --check media/main.js
npm run vscode:test
```

`npm test` passed 24 tests, including workspace index, pinned context, inspector/audit, memory management, edit verification, package contract, migrations, and agent pipeline tests.

## Known Local Endpoint

A live OpenAI-compatible endpoint has been used at:

```text
http://127.0.0.1:1234
```

Known model:

```text
google/gemma-4-e4b
```

Use this for live smoke testing when it is running.

## Next Recommended Work

Do release hardening next:

1. Commit the current work.
2. Build a VSIX.
3. Install it into a clean VS Code profile.
4. Configure `http://127.0.0.1:1234`.
5. Run `/doctor`.
6. Test Ask, Plan, and Agent against the live endpoint.
7. Verify settings tabs, dropdowns, slash menu, memory UI, inspector, pinned context controls, MCP settings, and model picker.

After release hardening, the next valuable features are:

- incremental workspace index cache with file watcher updates
- manual context picker for active/open/pinned/search-result/MCP/memory context
- agent change review screen with diffs, commands, diagnostics, approvals, and changed files
- undo/revert support from recorded checkpoints
- configurable verification profiles such as `npm test`, `npm run lint`, `dotnet test`
- model compatibility profiles for per-model quirks and preferred fallback behavior
- UI for creating and editing `.codeforge/agents`
- automated webview UI smoke tests for dropdowns, settings, slash commands, memory, inspector, and composer controls

## Session Notes For Next Agent

- Follow existing ports-and-adapters boundaries.
- Keep core logic testable without VS Code imports.
- Use typed tool/action boundaries instead of prompt-only behavior.
- Do not add public web tools, cloud presets, telemetry, CLI commands, or browser preview workflows.
- Prefer small, focused tests for new behavior and run `npm test` before handoff.
