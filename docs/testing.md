# CodeForge Testing

CodeForge is a VS Code extension-only local coding harness. Tests should verify the internal tool pipeline first, then the VS Code host, then optional live local endpoint behavior.

## Standard Suite

Run this before committing code changes:

```bash
npm test
```

This compiles the test project and runs:

- core unit tests
- tool registry validation tests
- permission matrix tests
- settings and session migration tests
- `/doctor` report tests
- offline workspace index tests
- pinned active-file context, run inspector, permission audit, edit verification, and memory-management integration tests
- package contract checks for VS Code-only/offline-first release shape
- MCP client tests
- deterministic `AgentController` pipeline integration tests

The integration harness uses a scripted in-memory LLM provider and fake workspace, diff, terminal, code-intel, notebook, memory, and MCP adapters. It tests CodeForge orchestration without relying on a live model.

## Production Compile

Run this before launching or packaging:

```bash
npm run compile
```

Check the webview script syntax when UI files changed:

```bash
node --check media/main.js
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
