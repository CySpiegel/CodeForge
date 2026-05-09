# Local Extensions

CodeForge local extensions are workspace-visible files under `.codeforge/`. They run inside the VS Code extension workflow and never add public network access.

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

Hook events are `preTool` and `postTool`. `tools` accepts exact tool names or `*`.

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
