# CodeForge

CodeForge is a Visual Studio Code extension that turns a configured OpenAI-compatible or Anthropic Messages API LLM endpoint into a coding assistant inside your editor.

It is designed for explicit endpoint control. CodeForge does not include public provider presets and keeps model traffic pointed at endpoints you configure, such as vLLM, LiteLLM, LM Studio, a corporate/cloud OpenAI-compatible gateway, or the Anthropic Messages API (api.anthropic.com directly, or an Anthropic-compatible gateway such as AskSage).

> **New here?** The [**User Guide**](docs/user-guide.md) walks through endpoint setup, the working and approval modes, the command surface, managing context on local models, sub-agents, memory, MCP, and troubleshooting.

## What CodeForge Does

CodeForge gives your local model a VS Code-native coding workflow:

- chat with repo context
- inspect and explain files
- search the whole codebase
- build an offline workspace index for faster codebase understanding
- read diagnostics from VS Code
- propose and apply file edits
- write to the currently open repo folder
- run approved terminal commands
- maintain workspace chat history
- keep and manage explicit local memories
- improve over time by saving curated memory and reusable skills from finished tasks
- delegate to background sub-agents (workers)
- use local slash commands, skills, and custom agents
- connect to explicitly configured MCP servers

The extension is not a CLI tool and does not use a browser or website preview workflow. All normal interaction happens inside the VS Code side panel and editor commands.

## Endpoint Support

CodeForge talks to two endpoint protocols. The protocol is inferred from the endpoint's base URL — there is no separate setting.

**OpenAI-compatible** (the default — any endpoint that follows the OpenAI Chat Completions shape):

- LM Studio: `http://127.0.0.1:1234`
- LiteLLM: `http://127.0.0.1:4000`
- vLLM: `http://127.0.0.1:8000`
- custom OpenAI-compatible endpoint origins explicitly allowed when saved in settings

Model discovery uses `/v1/models`; chat requests use `/v1/chat/completions`, including native OpenAI tool calls when the selected model and server support them.

**Anthropic Messages API** (native `/v1/messages`). CodeForge selects this protocol when the base URL is:

- the official API: `https://api.anthropic.com` (authenticated with your key via `x-api-key`)
- an Anthropic-compatible gateway whose path ends in `/anthropic`, e.g. AskSage's `https://api.asksage.ai/server/anthropic` (authenticated with `Authorization: Bearer`)
- a local server that serves the Messages API alongside an OpenAI API on the same origin — opt in with a `#anthropic` fragment, e.g. LM Studio's `http://127.0.0.1:1234#anthropic`

Anthropic endpoints stream the native SSE format, support native tool calls, and discover models from `/v1/models` (falling back to the known Claude lineup when the endpoint omits token metadata).

## Safety Model

CodeForge is local-first by default and never reaches a public endpoint without your explicit action:

- no telemetry
- no bundled provider presets — including no cloud presets; nothing points at a public API out of the box
- localhost and private IP ranges are allowed
- any other endpoint origin — including a public cloud API like `api.anthropic.com` or AskSage — is reachable only after you explicitly save that URL as an endpoint in settings (which adds its origin to the network allowlist)
- API keys are stored in VS Code SecretStorage
- edits, commands, MCP calls, and memory writes go through typed validation and approval policy
- permission decisions, approvals, and tool execution are visible in the run inspector

Approval modes:

- **Manual**: asks before meaningful actions such as edits, commands, and service calls.
- **Smart**: allows reads and searches without prompting; asks before edits, commands, memory writes, notebook edits, and service calls.
- **Full Auto**: allows most actions without interruption; best used in disposable branches or containers.

## Agent Modes

CodeForge has three working modes:

- **Ask**: quick answers, explanations, debugging help, and read-only workspace inspection.
- **Plan**: codebase analysis and implementation planning before changes.
- **Agent**: hands-on coding mode that can read, search, edit, run approved commands, and iterate.

Modes can be selected from the chat input controls or with slash commands:

```text
/ask
/plan
/agent
```

## Internal Tools

The model can use validated internal tools instead of guessing what the workspace looks like. Tool coverage includes:

- file listing, globbing, reading, and text search
- offline workspace indexing
- VS Code diagnostics
- exact file writes and edits
- unified diff proposals and previews
- terminal command execution with bounded output
- task tracking
- structured user questions
- local memory writes
- worker agent delegation
- VS Code language-service lookups
- notebook read/edit support
- MCP resource listing, reading, and tool calls

Specialized tool schemas are loaded on demand with `tool_search`, keeping the active model context smaller for local models.

After file edits, CodeForge checks current VS Code diagnostics for changed files and returns those results to the model so Agent mode can continue from real feedback.

## Learning & Memory

CodeForge keeps two kinds of local memory and can improve its own reusable skills over time. Everything is local — no telemetry, no external services.

**Curated memory.** When `codeforge.memory.enabled` is on, CodeForge injects two note sets into the system prompt — MEMORY (environment facts, project conventions, tool quirks) and a separate USER profile (your preferences and working style) — and exposes a `memory` tool so the agent can save durable facts across sessions. Budgets are bounded by `codeforge.memory.charLimit` and `codeforge.memory.userCharLimit`; the agent consolidates entries when it reaches a limit. A background memory review runs every `codeforge.memory.nudgeInterval` user turns.

**Self-improvement review.** After Agent-mode turns, a non-blocking background review may save new memory and author or refine reusable **skills** under `.codeforge/skills` (via the `skill_manage` tool). These updates are applied directly rather than held in a review queue, and are guarded — a skill write is blocked after a failed run (anti-poisoning) — and the whole pass is fire-and-forget: it never blocks or breaks a run.

**Curation.** A periodic curator consolidates overlapping skills and archives stale ones. It never deletes (archives are recoverable) and pinned skills are exempt.

Inspect and manage all of this from chat with `/memory`, `/skills`, `/skill`, and `/curator`.

Self-improvement is governed by three settings — all default **on**. To stop the agent from writing to local memory and skill files entirely, set all three to `false`:

- **`codeforge.memory.enabled`** — durable curated memory (sized by `codeforge.memory.charLimit` / `codeforge.memory.userCharLimit`).
- **`codeforge.skills.enabled`** — authoring and refining reusable skills under `.codeforge/skills` (nudged by `codeforge.skills.creationNudgeInterval`).
- **`codeforge.curator.enabled`** — the periodic skill-library curation pass that consolidates and archives skills (cadence via `codeforge.curator.intervalHours` / `codeforge.curator.minIdleHours`).

The review surfaces what it does live in chat (`🧠`/`👤`/`🛠️` notices when it saves a memory, profile note, or skill). Tune how much it shows with **`codeforge.review.verbosity`** (`verbose` | `concise` | `status` | `silent`, default `verbose`); in `verbose` it also reports a "Reviewed — nothing new" line so you always know the review ran. Learning runs regardless — this only controls visibility.

For a durable, searchable fact store with compositional recall, set `codeforge.memory.provider` to `holographic` (default `none`); it mirrors saved memories and recalls relevant facts into each task's context, fully local.

## Chat Commands

CodeForge ships a large set of slash commands. The list below is a useful selection; type `/` in the chat input to see the rest.

```text
Modes
/ask /plan /agent          Switch working mode

Permission/approval modes
/smart /default            Smart approval (reads/search allowed, asks before edits & commands)
/manual /readonly          Ask before edits, commands, and service calls
/fullauto /workspacetrusted Proceed without most prompts
/acceptedits               Alias for Smart mode (legacy name; still asks before edits)

Session control
/new                       Start a clean workspace chat
/history /chats /sessions  Show saved local chats
/resume                    Resume a saved chat
/fork                      Branch the current chat into a new one
/diff                      Show pending edits as a diff
/export                    Export the current chat
/clear /reset              Clear the conversation
/stop /cancel              Stop the active operation

Context
/context                   Show current context usage
/compact                   Compact the current chat context
/pin /unpin /pins          Manage files pinned into future context
/index                     Show the offline workspace index

Inspection & diagnostics
/doctor                    Check endpoint, model, workspace, permissions, MCP, persistence
/inspect /inspector        Show recent model/tool/verification events
/audit                     Show permission and approval audit history
/capabilities              Show cached endpoint model capabilities

Model & configuration
/model                     Show or set the active model
/models                    Pick from models returned by the active endpoint
/settings /config          Open CodeForge settings

Sub-agents & extension points
/workers                   Show background workers
/worker                    Show, attach, or stop worker output
/agents                    List agent definitions (built-in kinds + workspace-local)
/review                    Run a read-only code review prompt
/commands                  List workspace-local slash commands
/skills /skill             List or run workspace-local skills
/memory                    Manage explicit local memories
/mcp                       Inspect configured MCP servers
```

## Workspace Extensions

Projects can add local CodeForge behavior under `.codeforge/`:

- `.codeforge/commands/*.md` for project slash commands
- `.codeforge/skills/*.md` or `.codeforge/skills/<name>/SKILL.md` for reusable skills
- `.codeforge/agents/*.md` or `.codeforge/agents/<name>/AGENT.md` for custom worker agents
- `.codeforge/hooks.json` for permission-gated local hooks
- `.codeforge/soul.md` for a bounded persona ("soul") that shapes the agent's voice and tone only — never its tools, permissions, or task behavior

Project instructions can be placed in `CODEFORGE.md` (with optional `CLAUDE.md` compatibility).

## Setup

1. Start or identify an OpenAI-compatible endpoint.
2. Open CodeForge in VS Code.
3. Open the CodeForge settings panel.
4. Add or edit an **OpenAI API** endpoint profile.
5. Set the base URL, such as `http://127.0.0.1:1234` or your corporate endpoint URL.
6. Select a model returned by the endpoint.
7. Run `/doctor` to verify the configuration.

Saving a custom endpoint automatically allows that exact origin in `codeforge.network.allowlist`.

## Development

Install dependencies and run the standard checks:

```bash
npm install
npm run compile
npm test
npm run vscode:test
```

Package a VSIX:

```bash
npm run package
```

For UI script changes, also run:

```bash
node --check media/main.js
```

## Project Layout

- `src/core`: provider contracts, network policy, tool validation, context, sessions, memory, learning, and pure logic
- `src/adapters`: VS Code, terminal, diff, config, session, memory, code-intel, notebook, and worktree adapters
- `src/agent`: model loop, tool orchestration, permissions, sub-agent workers, learning hooks, and diagnostics
- `src/ui`: VS Code webview provider and message bridge
- `media`: chat UI scripts (decomposed into `window.CodeForge` modules — markdown, DOM utils, inspector, approvals, MCP editor, worker list, slash commands, and the `main.js` core), styles, and extension icon
- `docs`: roadmap, testing notes, and local extension formats

See `docs/user-guide.md` for the full guide to using CodeForge — modes, commands, context, sub-agents, memory, MCP, and troubleshooting.
See `ARCHITECTURE.md` for implementation boundaries and design patterns.
See `docs/testing.md` for verification steps.
See `docs/local-extensions.md` for local commands, skills, agents, hooks, and the `soul.md` persona.
