# CodeForge

CodeForge is a Visual Studio Code extension that turns a configured OpenAI-compatible LLM endpoint into a coding assistant inside your editor.

It is designed for explicit endpoint control. CodeForge does not include public provider presets and keeps model traffic pointed at endpoints you configure, such as vLLM, LiteLLM, LM Studio, or a corporate/cloud OpenAI-compatible gateway.

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
- learn durable lessons from finished tasks and apply them later
- delegate to background sub-agents (workers)
- use local slash commands, skills, and custom agents
- connect to explicitly configured MCP servers

The extension is not a CLI tool and does not use a browser or website preview workflow. All normal interaction happens inside the VS Code side panel and editor commands.

## Endpoint Support

CodeForge talks to OpenAI API style endpoints. The endpoint implementation can be anything that follows that API shape.

Common examples:

- LM Studio: `http://127.0.0.1:1234`
- LiteLLM: `http://127.0.0.1:4000`
- vLLM: `http://127.0.0.1:8000`
- custom OpenAI-compatible endpoint origins explicitly allowed when saved in settings

Model discovery uses `/v1/models`. When the endpoint exposes model metadata, CodeForge uses it for context length and reasoning-model indicators. Chat requests use `/v1/chat/completions`, including native OpenAI tool calls when the selected model and server support them.

## Safety Model

CodeForge is local-first by default:

- no telemetry
- no bundled cloud-provider presets
- localhost and private IP ranges are allowed
- custom endpoint origins are allowed only after you save that URL in settings
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

When an Agent-mode task finishes, CodeForge distils durable **lessons** from its own work — corrective ones from failures, reusable ones from successes — and stores them as scoped memory entries. On later tasks it ranks the relevant lessons and injects them back into both the main loop and sub-agents. This is fire-and-forget and fully guarded: learning never blocks or breaks a run.

CodeForge can also propose extension files from what it learns:

- repeated successful procedures may be proposed as reusable **skills** (`.codeforge/skills`)
- recurring task *types* may be proposed as **review-only sub-agents** (`.codeforge/agents`)

A periodic self-audit dedups and prunes the lesson library. The **Learned** panel in the settings view lets you accept or reject proposed lessons, skills, and agents, and shows a pending-count badge. Inline chat surfaces provenance such as "Learned N…" and "Applied N learned lessons".

Learning is controlled by `codeforge.learning.*` settings and can be fully disabled with `codeforge.learning.enabled`:

- **autonomy** (`review` | `hybrid` | `auto`, default `hybrid`): hybrid applies text lessons automatically and proposes skill files for review; review keeps everything pending in the Learned panel; auto saves lessons silently. Proposed agent files are **always review-only** and are never written without approval, even under `auto`.
- **scope** (`split` | `repo` | `global`, default `split`): split keeps project lessons in the repo while preferences follow you across repos; repo keeps everything per-project; global shares across every project.
- skill proposals (`skills.enabled`, default on) trigger after a procedure recurs (`skills.minRepeats`, default 3); agent proposals (`agents.enabled`) are opt-in and off by default.

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
- `media`: chat UI script, styles, and extension icon
- `docs`: roadmap, testing notes, and local extension formats

See `ARCHITECTURE.md` for implementation boundaries and design patterns.
See `docs/testing.md` for verification steps.
See `docs/local-extensions.md` for local commands, skills, agents, hooks, and the `soul.md` persona.
