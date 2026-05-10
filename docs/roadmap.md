# CodeForge Roadmap

CodeForge is a VS Code extension only. There will be no CLI edition and no browser or website workflow. The goal is to bring the strongest harness techniques from Harnes into a local-first editor workflow while preserving the original CodeForge principles:

- local and on-prem OpenAI-compatible endpoints only
- supported endpoint targets are vLLM and LiteLLM-compatible `/v1` servers
- no telemetry
- offline and private workspace posture first
- public IP destinations blocked
- explicit hostname configuration is for private/on-prem LLM endpoints only
- file writes and shell commands gated by typed approval flows
- ports-and-adapters architecture with VS Code isolated behind adapters
- small, typed core modules with focused tests
- no website preview, browser automation, or internet search surface

## Non-Goals

- No CLI version.
- No hosted web app.
- No browser preview surface for viewing work on websites.
- No cloud provider presets.
- No public internet tool access.
- No web fetch or web search tools.

## Guiding Architecture

- `src/core` remains free of VS Code imports and owns types, tool schemas, parsing, permissions, session records, context budgeting, and policy decisions.
- `src/adapters` owns VS Code workspace APIs, secrets, terminal execution, diff previews, persistence, and future local index providers.
- `src/agent` owns orchestration, model loops, tool execution, approval waits, state transitions, and cancellation.
- `src/ui` and `media` own the VS Code extension view and message bridge behavior.
- Runtime dependencies stay minimal unless they replace risky custom code with a proven parser, indexer, or protocol implementation.

## Phase 0: Stabilize The Current Harness

Status: implemented in the current harness foundation.

Scope:
- Keep the committed UI controls stable.
- Finish the Harnes-style tool registry already started for read/search/edit/command actions.
- Preserve native OpenAI tool-call transcripts with matching tool-result messages.
- Continue the agent loop after approved or rejected tool requests.
- Keep JSON action fallback for endpoints without native tool calls.

Exit criteria:
- `npm run compile` and `npm test` pass.
- Read/search tools run without approval.
- Patch/command tools request approval and feed results back into the next model turn.
- Tool status rows render without empty assistant messages.

## Phase 1: Permission And Policy Engine

Purpose: make autonomy safer before adding more tools.

Status: initial implementation in place.

Scope:
- Add a core permission engine with explicit `deny -> ask -> allow` precedence.
- Support session, workspace, and user scopes.
- Add rule types for tools, workspace paths, shell command prefixes, and private/on-prem endpoint access.
- Add permission modes suitable for an extension:
  - `default`: reads allowed, writes and commands ask.
  - `review`: all writes and commands ask, even if allowlisted.
  - `acceptEdits`: file edits may apply after preview, commands still ask.
  - `readOnly`: deny writes and commands.
  - `workspaceTrusted`: permit configured low-risk commands only.
- Add settings UI for viewing and removing persisted rules.
- Add tests for rule matching, precedence, and path normalization.

Exit criteria:
- Every write and command decision has a recorded source: rule, mode, or user approval.
- Approval cards explain why approval is needed.
- Denied actions are returned to the model as structured tool errors.
- No core permission code imports VS Code.

## Phase 2: VS Code-Native File And Search Tools

Purpose: improve the model's workspace visibility without shelling out.

Status: initial implementation in place.

Scope:
- Expand the registry with `list_files`, `glob_files`, `grep_text`, `read_file`, `write_file`, `edit_file`, and `open_diff`.
- Use VS Code workspace APIs first; use local ripgrep only as an optional adapter if available.
- Add bounded output, binary-file rejection, ignored-path policy, and max-result controls.
- Add file edit validation with old/new text matching and unified diff preview.
- Add editor-aware context from active file, selection, visible tabs, diagnostics, and file symbols.

Exit criteria:
- Common codebase exploration does not require shell commands.
- Large file/search results are clipped consistently with clear tool-result messages.
- File writes always preview through VS Code diff UI before approval.
- Unit tests cover parser/validator behavior; adapter tests cover workspace path safety.

## Phase 3: Session Persistence And Checkpoints

Purpose: make CodeForge recoverable and auditable inside VS Code.

Status: initial implementation in place. Sessions are stored as local JSONL records in VS Code storage, the chat view replays the latest transcript on reload, `/history`, `/resume`, `/fork`, `/diff`, `/export`, and `/clear` are available from the extension chat, and checkpoints are recorded before approved edits and commands.

Scope:
- Persist session records as local JSONL under workspace or extension storage.
- Record messages, assistant deltas, tool calls, tool results, approvals, decisions, diffs, and command summaries.
- Add `/resume`, `/history`, `/fork`, `/diff`, and `/clear` semantics in the VS Code extension view.
- Add lightweight checkpoints before approved edits and commands.
- Add cancellation and resume behavior that never replays approved side effects automatically.

Exit criteria:
- Reloading VS Code can resume a session without losing tool context.
- A session can be exported without secrets.
- Approved side effects are distinguishable from proposed side effects.
- Persistence is local-only and documented.

## Phase 4: Context, Memory, And Local Instructions

Purpose: make model context deliberate and explainable.

Status: initial implementation in place. CodeForge loads local `CODEFORGE.md` and optional `CLAUDE.md` project instructions, supports explicit `/memory` add/list/remove/clear commands, attaches saved local memories to model context, reports itemized context usage plus last attached local context through `/context`, and deterministically compacts older large tool results only when no approvals are pending.

Scope:
- Replace the single context percentage with itemized context accounting.
- Add `/context` breakdown by user messages, assistant messages, tool results, open files, project instructions, and memory.
- Load `CODEFORGE.md` project instructions, with optional `CLAUDE.md` compatibility if present.
- Add explicit user-approved local memories, stored locally.
- Add automatic context compaction policies for old tool outputs.
- Add tool-result summarization that preserves file paths, decisions, and pending work.

Exit criteria:
- Users can see what local data is being sent to the configured endpoint.
- Project instructions are deterministic and locally inspectable.
- Context compaction never hides pending approvals or unapplied edits.
- No memory is written without explicit user action.

## Phase 5: Shell Execution, Sandboxing, And Task Output

Purpose: make shell use powerful but controlled in an extension environment.

Status: initial implementation in place. Foreground commands stay workspace-scoped, approval details show command risk, cwd, timeout, output limit, and permission reason, shell output is bounded per stream, command execution uses a scrubbed environment, background shell operators are rejected until tracked background tasks are available, and users can stop running requests from the view or `/stop`.

Scope:
- Harden command classification using a real parser where practical.
- Add command allow/deny rules with prefix matching and destructive-command warnings.
- Add foreground command streaming and background task support.
- Persist bounded task output locally with retrieval tools.
- Add configurable timeout, output limits, environment controls, and working-directory checks.
- Prefer VS Code terminal/process APIs through an adapter so implementation stays platform-aware.

Exit criteria:
- Commands show risk, cwd, timeout, and permission reason before approval.
- Long-running commands can be stopped from the UI.
- Background output can be queried without flooding model context.
- Shell execution remains workspace-scoped unless explicitly approved.

## Phase 6: VS Code-Native Coding UX

Purpose: make CodeForge feel like an editor assistant, not a terminal transcript.

Status: initial implementation in place. Tool results render as collapsible timeline entries, approval cards can reopen VS Code diff previews, diagnostics are available through a local read-only tool, selected-code commands include ask/edit/explain/generate tests/fix diagnostics, the status bar shows active CodeForge model/profile/context usage, and the sidebar supports basic keyboard navigation polish.

Scope:
- Add a session timeline with collapsible tool calls and results.
- Add inline diff review actions: apply, reject, edit prompt, open file.
- Add diagnostics and quick-fix integration.
- Add commands for selected code: ask, edit, explain, generate tests.
- Add status bar model/profile/context indicators.
- Add extension-view accessibility, keyboard navigation, and narrow-sidebar polish.

Exit criteria:
- Users can complete edit-review-verify loops without leaving VS Code.
- Tool output is readable but collapsible.
- Selection and active editor state are first-class inputs.
- UI state is recoverable after VS Code view reload.

## Phase 7: Local Extension Points

Purpose: make the harness extensible without compromising offline-first behavior.

Status: initial implementation in place. Workspace-local slash commands are loaded from `.codeforge/commands/*.md`, local skills are loaded from `.codeforge/skills/*.md` and `.codeforge/skills/<name>/SKILL.md`, `/commands`, `/skills`, and `/skill` expose those files in the chat, and `.codeforge/hooks.json` supports `preTool` and `postTool` command hooks that must pass the same command validation and permission policy as model-requested shell commands.

Scope:
- Add file-backed custom slash commands.
- Add local skills as markdown instruction packs.
- Add hooks for local pre-tool and post-tool checks.
- Add a local-only plugin folder format if repeated extension points need packaging.
- Keep all extension loading opt-in and workspace-visible.

Exit criteria:
- A workspace can define commands and skills without network access. Initial support is under `.codeforge/`.
- Hook failures fail closed for writes/commands. Hook commands must be explicitly allowed by permission rules.
- Extension-point errors are visible and do not crash the agent loop.

## Phase 8: Local Protocol And Service Integrations

Purpose: add local protocol integrations while preserving offline-first network policy.

Status: complete for the VS Code extension baseline. MCP servers are configured through the in-app settings screen, validated against the offline network policy, exposed through slash commands, and called through the shared permission engine. Streamable HTTP, legacy SSE, and stdio transports are supported. MCP tools return structured tool results, and MCP resources can be explicitly attached to chat context.

Scope:
- Add MCP client support through an adapter.
- Allow only explicitly configured MCP servers.
- Apply the same permission engine to MCP tools.
- Default to local transports, localhost endpoints, and private on-prem service hostnames.
- Add network-policy checks for any HTTP/SSE MCP transports.
- Surface MCP resources in context only when requested or selected.

Exit criteria:
- MCP tools appear in the registry with typed schemas and permission metadata.
- Public MCP endpoints are out of scope and blocked.
- MCP errors return structured tool results.
- No MCP server starts or connects without visible configuration.

## Phase 9: Focused Multi-Agent Workflows

Purpose: bring useful Harnes-style delegation into VS Code without becoming a terminal swarm UI.

Status: initial implementation in progress. CodeForge now has a VS Code-native worker task layer for bounded local workers. The first slice supports read-only Explore, Plan, Review, and Verify workers that run against the active OpenAI-compatible endpoint, inherit the same workspace context policy, persist worker records in the local session JSONL stream, and render worker status in the extension view. Write-capable workers, command-capable verification, and permission bubbling for side effects remain follow-up work.

Scope:
- Add bounded worker sessions for codebase exploration, implementation planning, review, and verification.
- Keep workers local to the same configured OpenAI-compatible endpoint, selected model, offline network policy, and workspace context policy.
- Give every worker an isolated transcript, abort controller, token/tool progress, and capped status summary.
- Enforce worker capabilities in code, not just prompts. Explore, Plan, Review, and the initial Verify worker are read-only and may only use VS Code-native read/search/diagnostic tools.
- Present worker output as summarized session artifacts in the VS Code extension view, not separate terminals, tmux panes, remote sessions, or website views.
- Persist worker start/progress/completion/failure records in local session storage.
- Add slash commands and UI affordances:
  - `/workers`
  - `/worker plan <task>`
  - `/worker output <id>`
  - `/worker stop <id>`
  - `/explore <task>`
  - `/review <scope>`
  - `/verify <task>`
- Add a future permission bridge before allowing any worker to run terminal commands, call MCP tools, or write files.
- Add explicit write scopes before adding implementation workers. No worker may make hidden background edits.

Exit criteria:
- Users can run a review or exploration worker from the VS Code extension view.
- Worker permissions cannot exceed the parent session.
- Worker summaries include files inspected, claims, and confidence.
- No hidden background edits.
- Reloading a workspace session can replay completed worker records.
- Running workers can be stopped from the extension view.

Follow-up slices:
- Command-capable Verify worker with parent approval bubbling for `run_command`.
- Scoped implementation workers that can only propose diffs for explicit paths and must surface VS Code diff previews through the parent approval queue.
- Worker transcript viewer polish, filtering, and transcript export.
- Worker output attachment back into the main chat context.

## Phase 10: Packaging, Reliability, And Local Operations

Purpose: make CodeForge dependable for daily use.

Scope:
- Add extension-host integration tests for core flows.
- Add endpoint diagnostics for LiteLLM and vLLM-compatible on-prem servers.
- Add `/doctor` for local config, network policy, model capability, and workspace permissions.
- Add migration handling for settings and session schema versions.
- Add release packaging checks.

Exit criteria:
- A fresh install can configure a local endpoint and run a read/edit/verify loop.
- Common setup failures have actionable diagnostics.
- Session and settings migrations are tested.
- Packaging does not add telemetry or cloud presets.

## Implementation Rules For Every Phase

- Keep core logic typed and unit-tested before adding UI affordances.
- Prefer adapters over direct VS Code calls outside `src/adapters` and `src/ui`.
- Add integration tests when behavior crosses provider, workspace, terminal, or VS Code view boundaries.
- Keep all network access behind `NetworkPolicy`.
- Store secrets only in VS Code SecretStorage.
- Avoid broad settings that silently weaken safety; make risky modes explicit and reversible.
- Do not add cloud-provider presets.
- Do not add browser, website preview, web fetch, or web search capabilities.
- Preserve JSON action fallback for smaller local models that do not support native tool calls.

## Recommended Build Order

1. Finish Phase 0 and commit it.
2. Implement Phase 1 before adding new side-effect tools.
3. Implement Phase 2 and Phase 3 together enough that file operations are auditable.
4. Add Phase 4 before expanding tool output volume.
5. Add Phase 5 before relying on shell-based workflows.
6. Add VS Code UX refinements continuously after each core capability lands.
