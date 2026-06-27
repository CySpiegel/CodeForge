# CodeForge user guide

CodeForge turns an OpenAI-compatible endpoint (LM Studio, vLLM, LiteLLM, or a corporate gateway) into a local-first coding agent inside VS Code. This guide covers how to use it well — configuring an endpoint, the working and approval modes, the command surface, keeping local models inside their context window, sub-agents, memory, project customization, MCP, and troubleshooting.

For installation and a feature overview see the [README](../README.md). For the exact `.codeforge/` file formats see [local-extensions.md](local-extensions.md). For architecture and design boundaries see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Contents

1. [Getting started](#getting-started)
2. [Working modes: Ask, Plan, Agent](#working-modes-ask-plan-agent)
3. [Approval modes and permission rules](#approval-modes-and-permission-rules)
4. [Slash command reference](#slash-command-reference)
5. [Managing context](#managing-context)
6. [Sub-agents (background workers)](#sub-agents-background-workers)
7. [Memory and self-improvement](#memory-and-self-improvement)
8. [Project customization (.codeforge/)](#project-customization-codeforge)
9. [Connecting MCP servers](#connecting-mcp-servers)
10. [Getting the best results with local models](#getting-the-best-results-with-local-models)
11. [Troubleshooting](#troubleshooting)

---

## Getting started

CodeForge drives an OpenAI-compatible endpoint that you configure yourself. There are no bundled provider presets — you point it at an endpoint you control and select a model that endpoint serves. This section gets you from a running endpoint to a verified setup.

### 1. Start or identify an endpoint

CodeForge talks to any backend that follows the OpenAI API shape. Start one locally or use an existing one. Common base URLs:

```text
LM Studio   http://127.0.0.1:1234
LiteLLM     http://127.0.0.1:4000
vLLM        http://127.0.0.1:8000
```

A corporate or cloud OpenAI-compatible gateway works too — you'll use its origin as the base URL.

Localhost and private IP ranges are allowed by default. A custom (non-local) origin is allowed only after you save it in settings (see step 5).

### 2. Open the CodeForge panel

Open CodeForge from the VS Code side panel. All normal interaction happens there and through editor commands — CodeForge is VS Code only, with no CLI or browser workflow.

Then open the CodeForge settings panel with:

```text
/settings
```

(`/config` does the same.)

### 3. Add an endpoint profile

Endpoints are stored as profiles in `codeforge.profiles`. Add or edit an **OpenAI API** profile with:

- **`label`** — a display name for the profile.
- **`baseUrl`** — your endpoint URL, e.g. `http://127.0.0.1:1234` or your gateway origin.
- **`defaultModel`** (optional) — a model id to use when `codeforge.model` is empty.
- **`extraHeaders`** (optional) — extra request headers, such as a gateway routing header.

Set `codeforge.activeProfile` to this profile's `id` to make it the one CodeForge uses.

### 4. Add the API key (SecretStorage)

API keys are **never** stored in `codeforge.profiles` or any settings file. They are kept in VS Code SecretStorage, referenced by the profile's `apiKeySecretName`. Set the key through the CodeForge settings panel rather than in `settings.json`. For a purely local endpoint with no auth, you can leave the key unset.

### 5. Saving a custom endpoint auto-allowlists it

When you save a profile with a custom (non-local) base URL, CodeForge automatically adds that exact origin to `codeforge.network.allowlist`. You don't need to edit the allowlist by hand for endpoints you've saved — only saved origins (plus localhost and private ranges) are reachable.

### 6. Select a model

CodeForge discovers models from the endpoint's `/v1/models`. To pick one served by the active endpoint:

```text
/models
```

This lists models returned by the endpoint and sets your choice. To view or set the active model id directly, use:

```text
/model
```

Your selection is written to `codeforge.model` (the model id sent to the active endpoint). If `codeforge.model` is empty, the active profile's `defaultModel` is used. When the endpoint exposes model metadata, CodeForge uses it for context length and reasoning-model indicators.

### 7. Verify with /doctor

Confirm everything is wired up:

```text
/doctor
```

This checks the endpoint, model, workspace, permissions, MCP, and persistence. If a check fails, revisit the matching step above — base URL and allowlist (steps 3 and 5), API key (step 4), or model selection (step 6).

---

## Working modes: Ask, Plan, Agent

CodeForge has three working modes that control how much the agent does on your behalf. They are separate from permission/approval modes (`/smart`, `/manual`, `/fullauto`), which control what the agent may do without prompting.

Pick the mode that matches the kind of help you want:

- **Ask** — quick answers, explanations, debugging help, and read-only workspace inspection. Use this when you want to understand code or get advice without any changes being made. The agent reads and searches the workspace but does not edit it.
- **Plan** — codebase analysis and implementation planning before changes. Use this when the task is non-trivial and you want the agent to investigate first and propose an implementation plan you can review, rather than diving straight into edits.
- **Agent** — hands-on coding mode. The agent can read, search, edit files, run approved commands, and iterate. Use this once you know what you want done and you're ready for the agent to make changes. After file edits, CodeForge feeds current VS Code diagnostics for the changed files back to the model so it can continue from real feedback.

### Switching modes

Select a mode from the chat input controls, or type a slash command in the chat:

```text
/ask     Read-only Q&A, explanations, and debugging
/plan    Analyze the codebase and produce an implementation plan
/agent   Edit, run, and iterate hands-on
```

A typical flow is to start in `/plan` to scope the work, review the proposed plan, then switch to `/agent` to carry it out. When something breaks and you only want to investigate, drop back to `/ask`.

Note that working mode and approval mode are independent: in `/agent`, your approval mode still decides whether edits and commands run automatically or wait for your confirmation.

---

## Approval modes and permission rules

CodeForge gates edits, command execution, MCP/service calls, and memory writes through an approval policy. You control how aggressive that gating is with an **approval mode**, and you can override individual decisions with **permission rules**.

### Choosing an approval mode

The mode is stored in `codeforge.permissions.mode` (default: `smart`). It has three values:

- **Manual** (`manual`): Asks before meaningful actions such as edits, commands, and service calls.
- **Smart** (`smart`): Allows reads and searches without prompting; asks before edits, commands, memory writes, notebook edits, and service calls.
- **Full Auto** (`fullAuto`): Allows most actions without interruption.

How to choose:

- Use **Manual** when you want to review every change before it happens.
- Use **Smart** for normal day-to-day work — you stay out of the way of read-only inspection but still confirm anything that modifies your workspace or reaches out to a service.
- Use **Full Auto** only in disposable branches or containers, where unreviewed edits and commands are cheap to throw away.

Switch modes from the chat input controls or with slash commands:

```text
/manual
/smart
```

You can also set the default for a workspace or your user profile by editing `codeforge.permissions.mode` in settings.

### Permission rules

Approval modes set the baseline. **Permission rules** (`codeforge.permissions.rules`) let you make specific exceptions — for example, always allow a safe command, or always deny writes to a sensitive path. Each rule is an object with these fields:

- **`kind`** (required) — what the rule matches against. One of:
  - `tool` — a specific tool
  - `path` — a file or directory path
  - `command` — a shell command
  - `endpoint` — a service/MCP endpoint
- **`pattern`** (required) — the value to match for that kind.
- **`behavior`** (required) — what to do on a match:
  - `allow` — run without prompting
  - `ask` — prompt for approval
  - `deny` — block the action
- **`scope`** (optional, default `workspace`) — `workspace` applies the rule to the current workspace; `user` applies it across all your projects.
- **`description`** (optional) — a note describing the rule's intent.

Example: always allow `git status`, never let anything write under `secrets/`:

```json
"codeforge.permissions.rules": [
  {
    "kind": "command",
    "pattern": "git status",
    "behavior": "allow",
    "scope": "workspace",
    "description": "Read-only git status is safe to auto-run"
  },
  {
    "kind": "path",
    "pattern": "secrets/**",
    "behavior": "deny",
    "scope": "user",
    "description": "Never edit secrets"
  }
]
```

Permission decisions, approvals, and tool execution are visible in the run inspector, so you can confirm which mode or rule applied to any action.

---

## Slash command reference

Type `/` in the chat input to see available commands and pick one. Each command runs immediately. Commands marked with aliases all behave identically. Several commands accept an optional argument after the name (for example `/model qwen2.5-coder`, `/pin src/app.ts`, `/agent fix the failing test`); when a mode command is given trailing text, that text is sent as the prompt in the new mode.

### Modes

Switch the agent's working mode. See the mode descriptions earlier in this guide for what each can do.

| Command | What it does |
| --- | --- |
| `/ask` | Switch to Ask mode (quick answers, explanations, read-only inspection). |
| `/plan` | Switch to Plan mode (analysis and implementation planning before changes). |
| `/agent` (alias `/auto`) | Switch to Agent mode (read, search, edit, run approved commands, iterate). |

### Permissions

Set the approval policy for tool use. The new mode persists for the session.

| Command | Sets mode | Behavior |
| --- | --- | --- |
| `/manual` (aliases `/readonly`, `/read-only`) | Manual | Asks before edits, commands, and service calls. |
| `/smart` (aliases `/default`, `/acceptedits`, `/accept-edits`) | Smart | Allows reads and searches; asks before edits, commands, memory writes, notebook edits, and service calls. |
| `/fullauto` (aliases `/full-auto`, `/workspacetrusted`, `/workspace-trusted`) | Full Auto | Proceeds without most prompts. Best used in disposable branches or containers. |

### Session control

| Command | What it does |
| --- | --- |
| `/new` (aliases `/clear`, `/reset`) | Start a clean workspace chat / clear the conversation. |
| `/history` (aliases `/sessions`, `/chats`) | Show saved local chats. |
| `/resume` | Resume a saved chat (pass an id, or run bare to choose). |
| `/fork` | Branch the current chat into a new one. |
| `/diff` | Show pending edits as a diff. |
| `/export` | Export the current chat. |
| `/stop` (alias `/cancel`) | Stop the active operation. |

### Context

| Command | What it does |
| --- | --- |
| `/context` | Show current context usage. |
| `/compact` | Compact the current chat context (pass optional focus text). |
| `/pin` | Pin a file into future context (`/pin <path>`, or bare to pin the active file). |
| `/unpin` | Remove a pinned file (`/unpin <path>`, or bare). |
| `/pins` | List currently pinned files. |
| `/index` | Show the offline workspace index. |

### Inspection & diagnostics

| Command | What it does |
| --- | --- |
| `/doctor` | Check endpoint, model, workspace, permissions, MCP, and persistence. |
| `/inspect` (alias `/inspector`) | Show recent model, tool, and verification events. |
| `/audit` | Show permission and approval audit history. |
| `/capabilities` | Show cached endpoint model capabilities. |

### Model & config

| Command | What it does |
| --- | --- |
| `/model` | Show the active model, or set it with `/model <name>`. |
| `/models` | Refresh and list models returned by the active endpoint, or set with `/models <name>`. |
| `/settings` (alias `/config`) | Open the CodeForge settings panel. |

### Sub-agents & extensions

| Command | What it does |
| --- | --- |
| `/workers` | Show background workers. |
| `/worker` | Show, attach to, or stop a worker's output. |
| `/agents` | List agent definitions (built-in kinds plus workspace-local). |
| `/review` | Run a read-only code-review prompt (pass an optional scope). |
| `/commands` | List workspace-local slash commands. |
| `/skills` | List workspace-local skills. |
| `/skill` | Run a workspace-local skill (`/skill <name>`). |
| `/mcp` | Inspect configured MCP servers. |

Workspace-local commands and skills live under `.codeforge/`. Any name you type after `/` that is not a built-in command is matched against your local commands.

### Memory

| Command | What it does |
| --- | --- |
| `/memory` | Manage explicit local memories. |
| `/undo` | Revert the last applied change. |
| `/curator` | Run or manage the skill-library curation pass. |

Memory and skill writes are governed by `codeforge.memory.enabled`, `codeforge.skills.enabled`, and `codeforge.curator.enabled` (all default on). All proposed edits, including memory and skill files, still route through the same approval flow as any other file change.

---

## Managing context

CodeForge keeps your model's context window small on purpose. Instead of dumping the whole repository into every prompt, the model pulls in exactly what it needs through validated internal tools — file listing, globbing, reading, text search, an offline index, and VS Code diagnostics. Specialized tool schemas are loaded on demand with `tool_search`, so the active context stays lean even on small local models. After an edit, CodeForge feeds current VS Code diagnostics for the changed files back to the model, so Agent mode iterates on real feedback rather than re-reading files.

This means you rarely need to paste large chunks of code. Let the model search and read; you steer it toward the right files.

### Build the offline index

For faster codebase understanding, build a workspace index the model can consult without scanning files on every turn.

```text
/index
```

This shows the offline workspace index. It runs locally — no model calls — and gives the agent a quick map of your repo.

### Pin files into context

When a few files are central to the task, pin them so they stay available to the model across turns.

```text
/pin <file>     Pin a file into future context
/unpin <file>   Remove a pinned file
/pins           List currently pinned files
```

Pin sparingly. Each pinned file consumes part of your token budget on every turn, so pin only the files the model genuinely needs to keep in view, and `/unpin` them once you move on.

### Check usage

See how much of the window you're using at any point.

```text
/context
```

Use this when responses start to feel truncated or when you're working with long files — it tells you whether you have room left before you hit the model's limit.

### Compact when the chat grows

Long conversations accumulate tokens. Compact the chat to summarize earlier turns and reclaim space.

```text
/compact
```

Compacting preserves the thread of the conversation while shrinking what's sent to the model. If you've set `codeforge.model.auxiliary` to a smaller model, the compaction turn runs on that model instead of your main coding model, keeping latency and tokens-per-minute pressure off the endpoint.

### Set the context budget

CodeForge sizes the context window from the model metadata returned by `/v1/models`. When the endpoint reports a context length, that value is used automatically.

Two settings control this:

- **`codeforge.context.maxTokens`** — Manual context window override in tokens. Default `0`, which means use the context length the selected model reports via `/v1/models`. Set a non-zero value to override that — useful when your endpoint underreports its window, or when you want to deliberately cap context on a machine with limited memory.
- **`codeforge.context.maxBytes`** — Legacy byte budget (default `120000`), used only as a fallback when no token context length is configured or discovered. Prefer `codeforge.context.maxTokens`; this key is deprecated.

Output length is bounded separately:

- **`codeforge.model.maxOutputTokens`** — Maximum tokens the model may generate per turn (sent as `max_tokens`). Default `32000`. It's automatically bounded to half the context window so the prompt always has room, and to the model's reported output limit, so it stays safe on small-context models. Set `0` to send no `max_tokens` and let the endpoint use the remaining window; set your own value for a custom cap.

### Staying within a local model's window

Local models often have small context windows. To stay inside them:

- Run `/doctor` after setup to confirm the endpoint and the discovered context length are what you expect.
- Check `/context` periodically; `/compact` before you run out rather than after responses start truncating.
- Pin only essential files and `/unpin` when done.
- Build `/index` so the model navigates the repo without re-reading large trees.
- If `/v1/models` underreports your model's true window, set `codeforge.context.maxTokens` to the correct value.
- Leave `codeforge.model.maxOutputTokens` at its default unless you specifically need longer single responses; it's already bounded to keep prompt room on small windows.

---

## Sub-agents (background workers)

CodeForge can delegate focused tasks to **background sub-agents** ("workers"). Each worker runs as its own model loop with its own scoped tools, while you keep working in the main chat. The agent launches workers as part of delegation; you can then watch, attach, or stop them.

### Worker kinds

Each worker is scoped to a kind that fixes its specialty and the tools it may use:

- **explore** — fast, read-only codebase exploration; searches and reads files to answer codebase questions.
- **plan** — read-only implementation planning; identifies patterns, critical files, sequencing, risks, and test strategy.
- **review** — read-only bug, risk, and regression review; leads with findings and file paths.
- **verify** — verification with approval-gated commands; inspects files and diagnostics, and may request build/test/lint commands when real evidence is needed. Ends with `VERDICT: PASS`, `FAIL`, or `PARTIAL`.
- **implement** — codebase-aware editing with approval-gated edits; reads first, then proposes or applies changes via CodeForge edit tools.
- **custom** — a workspace-local agent you define under `.codeforge/agents/`.

A read-only worker (explore, plan, review) cannot write files, run commands, or call MCP tools. The verify and implement workers can request commands or edits respectively, but every command and edit is routed back through the parent VS Code approval, diff preview, checkpoint, and **permission policy** — so a worker can never bypass your current approval mode (Manual, Smart, or Full Auto).

### Inherited context

Workers build their own workspace context and inherit relevant **skill context** alongside the same MCP resources available to the main loop, so a delegated task starts with the skills CodeForge has already built.

### Concurrency and queueing

To avoid overwhelming a single local endpoint with a fan-out, the number of workers running at once is capped by:

```text
codeforge.workers.maxConcurrent   (default 3, range 1–16)
```

Spawns beyond the cap are not dropped — they **queue and start as running workers finish**. You can raise or lower the cap in CodeForge settings (`/settings`).

### Viewing, attaching, and stopping

Use the slash commands to manage running workers:

```text
/workers                Show all worker tasks and their status
/worker output <id>     Show a worker's transcript
/worker attach <id>     Attach a worker's output to the main chat context
/worker stop <id>       Stop a running worker
/agents                 List worker agent definitions (built-in kinds + workspace-local)
```

Steps to follow a delegated task:

- Run `/workers` to find the worker `<id>` and its current status (running, completed, stopped, or failed).
- Run `/worker output <id>` to read its transcript, including the files it inspected and its final report.
- Run `/worker attach <id>` to pull that worker's result into your main chat so you can build on it.
- Run `/worker stop <id>` to cancel a worker you no longer need.

Workers do not survive a VS Code session: any worker still running when the session ends is marked stopped on restore.

---

## Memory and self-improvement

CodeForge keeps two kinds of local memory and can refine its own reusable skills over time. Everything is local — no telemetry, no external services — and is governed by three settings that all default **on**.

### Curated memory

When `codeforge.memory.enabled` is on, CodeForge injects two note sets into the system prompt:

- **MEMORY** — environment facts, project conventions, and tool quirks the agent should remember.
- **USER profile** — who you are: your preferences, communication style, and expectations.

The agent saves durable facts with the `memory` tool, and a background memory review runs every `codeforge.memory.nudgeInterval` user turns (default `10`; `0` disables it). Budgets are bounded by `codeforge.memory.charLimit` (MEMORY, default `2200`) and `codeforge.memory.userCharLimit` (USER profile, default `1375`); the agent consolidates entries when it reaches a limit. Inspect your memory from chat with `/memory`.

### The self-improvement review

After Agent-mode turns, a non-blocking background review may save new memory and author or refine reusable **skills** under `.codeforge/skills` (via the `skill_manage` tool). The important points:

- Skill updates are **applied directly** — there is no accept/reject proposal queue.
- A skill write is **blocked after a failed run** (anti-poisoning), so CodeForge does not learn from broken work.
- The whole pass is **fire-and-forget**: it runs only after a finished turn and never blocks or breaks a run.
- It touches **skills and memory only** — it never creates or proposes worker agents (`.codeforge/agents` files are authored only by you).

The review is gated by `codeforge.skills.enabled` and nudged every `codeforge.skills.creationNudgeInterval` tool iterations (default `10`). List and run the resulting skills with `/skills` and `/skill`.

You can see the review happen: when it saves something it posts a short chat notice — `🧠 Learned a lesson…`, `👤 Updated your profile…`, or `🛠️ Created/Improved a skill…`. How loud this is is controlled by **`codeforge.review.verbosity`** (default `verbose`):

- `verbose` — a transient `🧠 Reviewing this session…` status, every save notice, **and** a `🧠 Reviewed — nothing new` line when a review saves nothing, so you always know it ran.
- `concise` — the status and save notices, plus a line only when a review fails; no "nothing new" line.
- `status` — only the transient reviewing indicator; no chat lines (saves still update the memory/skills panels).
- `silent` — no status and no chat lines; the review still runs in the background.

Learning runs regardless of this setting — it only controls what you see.

### Curation

A periodic curator consolidates overlapping skills and archives stale ones. It **never deletes** — archives are recoverable — and **pinned skills are exempt**. It is gated by `codeforge.curator.enabled`, with cadence from `codeforge.curator.intervalHours` (default `168` = one week) and `codeforge.curator.minIdleHours` (default `2`). Check or run it with `/curator`.

### Turning it off

To stop the agent from writing to local memory and skill files entirely, set all three to `false`:

```json
"codeforge.memory.enabled": false,
"codeforge.skills.enabled": false,
"codeforge.curator.enabled": false
```

### A stronger memory backend

For durable, searchable recall, set `codeforge.memory.provider` to `holographic` (default `none`). It mirrors saved memories into a compositional fact store and recalls relevant facts into each task's context. Fully local; no external services.

---

## Project customization (.codeforge/)

You can teach CodeForge project-specific behavior by adding files under a `.codeforge/` folder in your workspace. These are workspace-visible files that run inside the VS Code extension — they never add network access. See [docs/local-extensions.md](local-extensions.md) for the full file formats.

### Project instructions (CODEFORGE.md)

Put standing project guidance in a workspace-root `CODEFORGE.md`. A `CLAUDE.md` is also read for compatibility. These are loaded into the model's context as persistent guidance, separate from the per-file extension points below.

### Project slash commands

Add a markdown file under `.codeforge/commands/*.md`. The filename becomes the command name.

```markdown
---
description: Review one area of the workspace
argument-hint: <path or topic>
skills: reviewer
---
Review {{args}}. Prioritize correctness bugs, regressions, and missing tests.
```

- Run it from chat: `/review src/agent/agentController.ts`
- `{{args}}` and `{{input}}` are replaced with the text after the command; if neither placeholder is present, your arguments are appended.
- List project commands with `/commands`.

### Reusable skills

Add a skill as a single file (`.codeforge/skills/reviewer.md`) or a directory (`.codeforge/skills/typescript/SKILL.md`). Each has a `description` in frontmatter and instructions in the body.

- List skills with `/skills`.
- Apply one directly: `/skill reviewer review the active file`
- Reference skills from a command's frontmatter: `skills: reviewer, typescript`.

### Custom worker agents

Add a worker agent as `.codeforge/agents/reviewer.md` or `.codeforge/agents/migration/AGENT.md`. Frontmatter keys are `label`, `description`, `tools`, and `max-turns` (alias `maxTurns`); the body is the agent's system prompt.

```markdown
---
label: Reviewer
description: Focused read-only code reviewer
tools: read, code
max-turns: 6
---
Review the requested area. Prioritize correctness bugs, regressions, and missing tests.
```

- `tools` is a comma-separated list of capability groups (e.g. `read`, `code`, `edit`, `command`, `mcp`, `all`) and/or exact registry tool names (e.g. `read_file`). Unknown entries are dropped; an empty or unresolved list yields a read-only toolset.
- `max-turns` is clamped to 1–12 (default 6).
- List your project agents with `/agents`. Launch one by delegating with the `spawn_agent` tool (e.g. `"agent": "reviewer"`); built-in kinds are shown by `/workers`. Every edit, command, or MCP side effect still goes through the parent approval and permission policy.

### Permission-gated hooks

Add `.codeforge/hooks.json` to run a command around tool execution.

```json
{
  "hooks": [
    {
      "name": "typecheck-before-edits",
      "event": "preTool",
      "tools": ["write_file", "edit_file", "propose_patch"],
      "command": "npm run compile",
      "timeoutSeconds": 60,
      "description": "Require the workspace to compile before applying edits."
    }
  ]
}
```

- Events are `preTool`, `postTool`, and `postToolFailure` (fires when a tool errors). `tools` accepts exact tool names or `*`.
- Hook commands run through the same command validator, scrubbed environment, timeout, and permission policy as model-requested commands. The command must be explicitly allowed by a permission rule, or it fails closed and blocks the tool action.

### Persona (soul.md)

Add `.codeforge/soul.md` to give the workspace agent a bounded persona. The body is injected as a "Persona" block that shapes voice and tone only — it never overrides tools, permissions, or task instructions. There is one soul per workspace, truncated to a small budget (4000 bytes) so it cannot crowd out tools or task context.

```markdown
Speak plainly and concisely. Prefer short sentences. Skip filler and praise.
```

---

## Connecting MCP servers

CodeForge can call tools and read resources from Model Context Protocol (MCP) servers, but only ones you have explicitly configured. CodeForge never connects to an MCP server unless it is configured in settings **and** a tool call requests it.

### Configure a server

MCP servers live in the `codeforge.mcp.servers` setting (an array). The easiest way to edit them is the MCP editor in CodeForge settings — open it with:

```
/settings
```

In the editor, add a server and fill in its fields:

- **id** (required) — a stable identifier for the server.
- **label** (required) — a display name.
- **enabled** — toggle the server on or off (defaults to on).
- **transport** (required) — one of `stdio`, `http`, or `sse`.

The remaining fields depend on the transport:

- For `stdio`: set **command** (the executable to launch), **args** (its arguments), and optionally **cwd** (the working directory).
- For `http` or `sse`: set **url**, and optionally **headers** (string key/value pairs, e.g. for authorization).

After editing, save your settings to apply the configuration.

### Check a server

Once a server is configured, use the **Check** button in the MCP editor to probe it. CodeForge connects to the server and lists its available **tools** and **resources** in the probe panel. If the server is disabled or its configuration is invalid, the panel tells you why (for example, a blocked or invalid configuration) instead of connecting.

Probe results show what the model would be able to call once a tool requests the server.

### Inspect from chat

Use the slash command to see your configured MCP servers:

```
/mcp
```

You can also run `/doctor`, which includes MCP among the things it checks (endpoint, model, workspace, permissions, MCP, persistence).

### Approval flow

MCP tool calls are not automatic. When the model invokes an MCP tool, the call goes through CodeForge's normal approval flow, the same as edits and shell commands — you review and approve (or reject) the request before it runs.

---

## Getting the best results with local models

Local endpoints vary widely in context window, output limits, and tool-calling quality. The settings below let you tune CodeForge to your model and hardware. All keys live under `codeforge.*` and can be set in VS Code Settings or via `/settings`.

### Pick the right model

Two model properties matter most for agent work:

- **Context window.** The agent reads files, runs tools, and accumulates tool output — all of which consume context. A larger context window lets you work on bigger tasks before CodeForge has to compact. CodeForge reads the model's context length from `/v1/models`; if your endpoint does not report it, set `codeforge.context.maxTokens` manually (in tokens; `0` means use the value from `/v1/models`).
- **Tool-calling.** CodeForge drives the model through native OpenAI tool calls. Prefer a model trained for tool/function calling. Run `/capabilities` to see the cached capabilities for the selected model and `/doctor` to verify the endpoint, model, and tool support end to end.

### Set the output token cap

`codeforge.model.maxOutputTokens` controls `max_tokens` sent to the endpoint:

- `32000` (default) — caps output at ~32k tokens. CodeForge automatically bounds this to half the context window (so the prompt always has room) and to the model's reported output limit, so it stays safe on small-context models.
- `0` — **no cap**: no `max_tokens` is sent, so the model can generate up to the remaining context window. Use this when you want the largest possible single response (on vLLM this fills the remaining context).
- `>= 1` — your own cap, bounded the same way as the default.

If long responses get cut off, raise this value or set it to `0`. If a small-context model runs out of room for the prompt, the automatic half-context bound already protects you, but you can also lower the cap explicitly.

### Offload background turns to a smaller model

CodeForge runs its own utility turns separately from your coding turns — context compaction, the background self-improvement (learning) review, and curator consolidation. Point these at a smaller, faster model so they don't compete with your main model:

```jsonc
"codeforge.model.auxiliary": "qwen2.5-3b-instruct"
```

- Leave it empty (default) to use the selected model for everything.
- The id must be served by your endpoint; if it isn't, CodeForge falls back to the selected model.
- On a single local endpoint, this reduces latency and tokens-per-minute pressure on your main model.

### Give slow models time between tool-call fragments

Some local models pause mid-stream while emitting tool-call arguments. If CodeForge ends a stream too early and you see truncated or invalid tool calls, increase the grace period the OpenAI adapter waits after the last streamed chunk:

```jsonc
"codeforge.requests.streamCompletionGraceSeconds": 60
```

Default is `30` seconds (range `1`–`120`). Related timeouts:

- `codeforge.requests.idleTimeoutSeconds` (default `300`) — how long CodeForge waits with no stream activity before stopping the request. Raise it for very slow models.
- `codeforge.requests.rateLimitRetries` (default `4`) — retries on HTTP 429 (e.g. a LiteLLM tokens-per-minute limit) or 5xx, honoring `Retry-After` or exponential backoff with jitter. Set to `0` to fail immediately.

### Native tool calls vs. invalid tool-call handling

CodeForge uses native OpenAI tool calls when the model and server support them. Weaker models sometimes emit malformed (unparseable) tool calls. `codeforge.agent.maxInvalidToolCallRetries` (default `3`) sets how many consecutive iterations of only-invalid tool calls the agent tolerates before stopping with an error.

- If a model frequently produces malformed calls, give it a little more slack by raising this value — but a persistently failing model usually signals weak tool-calling support, and switching models is the better fix.
- Specialized tool schemas are loaded on demand via `tool_search`, which keeps the active context smaller and helps smaller models stay reliable.

### Keep tasks scoped

Local models do best on focused work. Smaller, well-defined tasks mean less accumulated context, fewer tool round-trips, and more reliable tool calls.

- Use `/context` to watch context usage, and `/compact` to compact when it grows large.
- Use `/pin`, `/unpin`, and `/pins` to keep the most relevant files in future context.
- Use `/plan` to scope a change before executing it in `/agent` mode.
- Start a clean chat with `/new` between unrelated tasks so stale context doesn't crowd the window.

---

## Troubleshooting

When something goes wrong, start with `/doctor`. It checks your endpoint, model, workspace, permissions, MCP, and persistence in one pass, and most of the issues below show up there first.

### Endpoint unreachable or origin not allowed

If chat requests fail to reach the model, the cause is usually either a down endpoint or an origin that is not on the network allowlist.

First steps:

- Run `/doctor` to confirm whether CodeForge can reach the configured base URL at all.
- Verify the endpoint is actually running and serving the OpenAI API shape (for example `http://127.0.0.1:1234` for LM Studio, `:4000` for LiteLLM, `:8000` for vLLM).
- If the failure is an origin/allowlist rejection rather than a connection error, check `codeforge.network.allowlist`. Localhost and private IP ranges are allowed by default; custom origins are allowed only after you save that exact URL in settings.

Saving a custom endpoint in the settings panel automatically adds its exact origin to `codeforge.network.allowlist`. If you hand-edited the base URL or your gateway moved hosts/ports, re-save the endpoint (or add the origin to the allowlist manually), since the allowlist matches the exact origin.

### Model not returned by /v1/models

CodeForge discovers models from the endpoint's `/v1/models` response. If your model does not appear:

- Run `/models` to list exactly what the active endpoint returns. If your model is missing here, the endpoint is not exposing it.
- Confirm the model is loaded/served on the backend (for example, that it is loaded in LM Studio or registered in your LiteLLM/vLLM config).
- Use `/model` to show or set the active model once it appears in the list.

### No tool calls or garbled tool calls

If the agent narrates actions in prose instead of using tools, or tool calls come back malformed, the model or server likely does not support native OpenAI tool calls well.

First steps:

- Run `/capabilities` to see the cached endpoint model capabilities, including whether the active model is treated as tool-call capable.
- Run `/inspect` to view recent model and tool events; this shows whether tool calls were emitted and how they were parsed.
- If tool-call argument fragments are arriving in pieces and being cut off, increase `codeforge.requests.streamCompletionGraceSeconds`. This is the time the adapter waits after the last streamed chunk before treating the stream as finished (default `30`), and the setting exists specifically for slow local models that pause between tool-call argument fragments.

### Context overflow

If responses degrade, get truncated, or the model loses earlier parts of the conversation, you may be running into the model's context length.

First steps:

- Run `/context` to see current context usage.
- Run `/compact` to compact the current chat, or `/new` to start a clean workspace chat.
- Use `/pin`, `/unpin`, and `/pins` to control which files are carried into future context, and drop pins you no longer need.

### Stalled or slow streams

If a request hangs or stops part-way through, two request settings control how long CodeForge waits.

- `codeforge.requests.idleTimeoutSeconds` (default `300`) is the maximum time CodeForge waits without any model stream activity before stopping the request. Raise it for very slow models that take a long time to start producing output.
- `codeforge.requests.streamCompletionGraceSeconds` (default `30`) is how long the adapter waits after the last chunk before considering the stream finished. Raise it if streams are being cut off early on a model that pauses mid-response.

First steps:

- Run `/inspect` to see whether the stream stalled mid-generation or never started.
- If it never started, suspect the endpoint or model load; re-check with `/doctor`.
- If it stalled mid-stream, raise `codeforge.requests.idleTimeoutSeconds`; if it ended early, raise `codeforge.requests.streamCompletionGraceSeconds`.
- Use `/stop` (or `/cancel`) to end a stuck operation, and `/audit` to review the permission and approval history if a run halted waiting on an approval.
