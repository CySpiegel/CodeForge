# Local Extensions

CodeForge local extensions are workspace-visible files under `.codeforge/`. They run inside the VS Code extension workflow and never add public network access.

Separately, project-wide instructions can be placed in a workspace-root `CODEFORGE.md` (with optional `CLAUDE.md` compatibility). These are loaded into model context as standing guidance, distinct from the per-file `.codeforge/` extension points described below.

## Local Slash Commands

Add markdown files under `.codeforge/commands/*.md`. The filename becomes the slash command name.

Example: `.codeforge/commands/review.md`

```markdown
---
description: Review one area of the workspace
argument-hint: <path or topic>
skills: reviewer
---
Review {{args}}. Prioritize correctness bugs, regressions, and missing tests.
```

Run it in the CodeForge chat:

```text
/review src/agent/agentController.ts
```

Use `/commands` to list local commands. `{{args}}` and `{{input}}` are replaced with the text after the slash command. If the template does not include either placeholder, CodeForge appends the user arguments.

## Local Skills

Add skills as markdown files:

- `.codeforge/skills/reviewer.md`
- `.codeforge/skills/typescript/SKILL.md`

Example:

```markdown
---
description: TypeScript review practices
---
Prefer strict types, small module boundaries, explicit error handling, and focused tests.
```

Use `/skills` to list skills. Use a skill directly with:

```text
/skill reviewer review the active file
```

Commands can reference skills with `skills: reviewer, typescript` in frontmatter.

## Local Agents

Add custom worker agents as markdown files:

- `.codeforge/agents/reviewer.md`
- `.codeforge/agents/migration/AGENT.md`

Each agent file has frontmatter and a system-prompt body. The body becomes the agent's instructions; the frontmatter keys are `label`, `description`, `tools`, and `max-turns` (alias `maxTurns`).

Example: `.codeforge/agents/reviewer.md`

```markdown
---
label: Reviewer
description: Focused read-only code reviewer
tools: read, code
max-turns: 6
---
Review the requested area. Prioritize correctness bugs, regressions, and missing tests.
Report Scope, Result, Key files, Issues, and Confidence.
```

The `tools` list is a comma-separated set of capability groups and/or exact tool names, validated against the real tool registry (`src/core/toolRegistry.ts`); anything unknown is dropped. Recognized capability groups are `read` (also `readonly`/`read-only`), `code` (also `lsp`/`symbols`), `state` (also `task`/`tasks`/`todo`/`todos`), `ask` (also `question`/`questions`), `edit` (also `write`/`files`), `notebook`/`notebooks`, `command` (also `shell`/`bash`/`terminal`), `mcp` (also `service`), `agent` (also `agents`/`delegate`), `memory` (also `remember`), and `all`. You can also name individual registry tools directly (for example `read_file`, `edit_file`). If `tools` is empty or resolves to nothing, the agent gets a read-only toolset. `max-turns` is clamped to the range 1-12 (default 6).

Use `/agents` to list your workspace-local agents. Launch one from chat by delegating with the `spawn_agent` tool (`"agent": "reviewer"`), naming either a local agent or a built-in kind (`explore`, `plan`, `review`, `verify`, `implement`); the built-in kinds are listed by `/workers`. Every edit, command, or MCP side effect a launched agent performs is still routed through the parent VS Code approval and permission policy.

## Persona (Soul)

Add `.codeforge/soul.md` to give the workspace agent a bounded persona. The body (frontmatter, if present, is stripped) is injected into the system prompt as a "Persona" block that shapes voice and tone only — it never overrides tools, permissions, or task instructions. There is one soul per workspace, and it is truncated to a small budget (4000 bytes) so it cannot crowd out tools or task context.

Example: `.codeforge/soul.md`

```markdown
Speak plainly and concisely. Prefer short sentences. Skip filler and praise.
```

## Local Hooks

Add hooks in `.codeforge/hooks.json`.

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

Hook events are `preTool`, `postTool`, and `postToolFailure` (which fires when the tool execution itself errors). `tools` accepts exact tool names or `*`.

Hook commands run through the same command validator, scrubbed environment, timeout, output limits, and permission policy as model-requested commands. A hook command must be explicitly allowed by a permission rule; otherwise it fails closed and blocks the tool action.

Example permission rule:

```json
[
  {
    "kind": "command",
    "pattern": "npm run compile",
    "behavior": "allow",
    "scope": "workspace",
    "description": "Allow local CodeForge compile hook"
  }
]
```

## Agent-authored skills

CodeForge's background self-improvement review can update the `.codeforge/skills/` folder from its own experience. After a turn completes, a non-blocking review pass curates the skill library via the `skill_manage` tool — patching an existing skill, adding a support file, or creating a new skill under `.codeforge/skills/<name>/SKILL.md`. These skill updates are written directly (a write is blocked only after a failed run, to avoid learning from broken work). A separate curator archives stale skills and consolidates overlapping ones — archiving, never deleting; pinned skills are exempt.

This review loop touches **skills and memory only — it never writes or proposes worker agents**. Files under `.codeforge/agents/` are authored solely by you. Gate the skill review with `codeforge.skills.enabled` and the curator with `codeforge.curator.enabled` (both default on).
