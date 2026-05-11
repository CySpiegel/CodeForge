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
- No web fetch or web search tools for now.
- No cron or scheduled job tools for now.

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

Status: implemented for the Phase 9 scope. CodeForge now has a VS Code-native worker task layer for bounded local workers. The current slice supports read-only Explore, Plan, and Review workers, a command-capable Verify worker with parent approval bubbling, an approval-gated Implement worker, and workspace-local custom agent definitions loaded from `.codeforge/agents/*.md` or `.codeforge/agents/<name>/AGENT.md`. Workers run against the active OpenAI-compatible endpoint, inherit the same workspace context policy, persist worker records in the local session JSONL stream, and render worker status in the extension view. The Harnes-style delegation path is also model-facing: the main agent and allowed local agents can use internal `spawn_agent`, `worker_output`, and approval-gated `memory_write` tools without exposing those as noisy primary UI controls.

Scope:
- Add bounded worker sessions for codebase exploration, implementation planning, review, and verification.
- Add an approval-gated implementation worker that can search, read, learn project patterns, and request file edits through the parent VS Code approval/checkpoint path.
- Add workspace-local user-defined agents with file-backed instructions, tool scopes, and max-turn configuration.
- Add model-facing internal tools for agent delegation, worker output retrieval, and local memory writes so the harness can coordinate work inside the model loop.
- Keep workers local to the same configured OpenAI-compatible endpoint, selected model, offline network policy, and workspace context policy.
- Give every worker an isolated transcript, abort controller, token/tool progress, and capped status summary.
- Enforce worker capabilities in code, not just prompts. Explore, Plan, and Review are read-only. Verify can request terminal commands only through the parent approval bridge. Implement and write-capable local agents can request edits only through the parent diff/checkpoint path.
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
  - `/implement <task>`
  - `/agents`
  - `/agent-run <name> <task>`
- Use a parent permission bridge before allowing any worker to run terminal commands, call MCP tools, or write files.
- No worker or local agent may make hidden background edits.

Exit criteria:
- Users can run review, exploration, implementation, or workspace-local custom agents from the VS Code extension view.
- Worker permissions cannot exceed the parent session.
- Worker summaries include files inspected, claims, and confidence.
- No hidden background edits.
- Reloading a workspace session can replay completed worker records.
- Running workers can be stopped from the extension view.
- Worker output can be inspected, attached back into the main chat context, or fetched by the model through the internal worker-output tool.

Follow-up slices:
- Local agent authoring UI for creating/editing `.codeforge/agents` files from inside the extension.
- Worker transcript viewer polish, filtering, and transcript export.

## Phase 9B: Harnes-Style Internal Tool Coverage

Purpose: close the tool capability gap while preserving VS Code-only, local/offline-first operation.

Status: implemented. CodeForge now exposes the Harnes-style tooling as typed, model-facing internal actions in the same agent loop rather than as a separate CLI surface. The implemented coverage includes structured user questions, local session task tracking, tool discovery, VS Code language-service queries, configured MCP resource list/read, VS Code notebook read/edit, and scoped local memory. Public web and cron tools remain explicitly out of scope.

Scope:
- Treat Harnes-style tools primarily as model-facing internal automations and state transitions, not as commands the user must manually drive.
- Include AskUserQuestion-style interaction so agents can pause and ask the user a structured question during a coding workflow.
- Include task/todo tools for durable multi-step work tracking.
- Include LSP code intelligence tools for hover, definitions, references, and symbols through VS Code APIs.
- Include direct MCP resource list/read tools for configured local/on-prem MCP servers.
- Include notebook edit support through VS Code notebook APIs.
- Include tool discovery for the model so local agents can inspect available CodeForge tools without guessing.
- Include local persistent memory improvements:
  - shared workspace memory
  - user preference memory
  - agent-specific memory namespaces
  - explicit user controls for inspect/remove/clear
- Exclude web fetch/search tools until explicitly re-scoped for local/on-prem use only.
- Exclude cron/scheduled job tools for now.

Exit criteria:
- Tool behavior is available to both the main agent loop and local agents where permissions allow it.
- Every side-effect tool uses the shared permission, approval, checkpoint, and local session record path.
- Persistent memory remains local, inspectable, and user-controllable.
- No public network capability is added.

## Phase 9C: Harnes-Style Orchestration Parity

Purpose: make the internal model/tool loop resilient enough for real repository work, not just simple one-shot actions.

Status: implemented for the critical orchestration gaps found in review. CodeForge now preserves invalid native tool calls in the transcript and returns explicit tool-result errors so local models can self-correct. The top-level agent loop has an agent-grade turn budget, concurrency-safe tools are batched by tool metadata rather than only by the small local read-tool subset, runtime tool failures return tool errors instead of breaking the loop, and configured MCP tools can be exposed as concrete native model tools while still routing through the existing `mcp_call_tool` permission path. CodeForge also has Harnes-style deferred tool schema loading: local models start with a smaller core tool surface and use `tool_search` to load specialized task, code-intel, notebook, memory, and MCP schemas on demand.

Scope:
- Raise the top-level model/tool loop from a short fixed cap to separate Agent and Ask/Plan turn budgets.
- Preserve every native tool call in the assistant transcript and always pair failed parses with a tool-result error.
- Apply the same invalid native tool feedback path to worker agents.
- Batch all concurrency-safe tools by registry metadata.
- Add `postToolFailure` local hook support for runtime tool failures.
- Surface configured local/on-prem MCP tools as concrete native function tools in Agent mode, with execution still mediated by CodeForge permissions and approvals.
- Add `tool_search` and deferred schema loading for the main agent and worker agents to reduce prompt/tool overhead for local models.

Remaining reliability work moves to Phase 10.

## Phase 10: Packaging, Reliability, And Local Operations

Purpose: make CodeForge dependable for daily use.

Status: implemented for the extension baseline. CodeForge now includes a `/doctor` diagnostic path that checks local/offline endpoint policy, OpenAI-compatible endpoint inspection, model discovery, context metadata, native tool-call support, workspace file discovery, approval behavior, MCP configuration, persistence availability, and internal tool registration. Settings permission-mode migration and session JSONL record migration are covered in core tests, package contract tests guard against CLI/cloud/web-tool release drift, and the extension-host suite verifies activation, contributed command registration, default configuration, and safe command execution.

Phase 10 entry baseline:
- `npm test` covers the deterministic unit and integration harness, including the internal AgentController tool pipeline, permissions, tool registry metadata, and MCP controller paths.
- `npm run vscode:test` passes against the VS Code extension host.
- The live local endpoint smoke against `http://127.0.0.1:1234` with `google/gemma-4-e4b` verifies native tool support plus Ask, Plan, and Agent controller flows.
- Manual UI validation is tracked in `docs/testing.md`.

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
