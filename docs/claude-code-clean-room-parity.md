# Claude Code Clean-Room Parity Review

This review is based on public Claude Code documentation and observable product behavior, not leaked or unlicensed source code. CodeForge should replicate useful harness capabilities clean-room while remaining a VS Code extension that talks only to local or on-prem vLLM/LiteLLM-compatible endpoints.

## Source Boundary

The linked `CySpiegel/claude-code-source` repository is not a safe implementation source unless the original rights holder grants a usable license. CodeForge can match behavior and architecture, but it must not copy source, prompts, schemas, or private implementation details from that repository.

## What Makes Claude Code Effective

- Agent loop: Claude Code cycles through context gathering, action, and verification. Tool results feed back into the next model decision instead of being treated as separate one-off chats.
- Tool surface: the harness gives the model file operations, workspace search, shell execution, local protocol integrations, code intelligence, focused workers, and user-interaction tools.
- Flow state: sessions persist as local records, can be resumed or forked, and include tool uses/results rather than only user/assistant text.
- Context management: context includes conversation, file contents, command output, project instructions, memory, skills, and tool definitions. It supports `/context`, automatic compaction, user-triggered `/compact`, and defers expensive tool definitions until needed.
- Permission model: read-only tools run freely, writes and shell commands are approval-gated, and permission modes/rules determine whether actions ask, deny, or auto-accept.
- Project memory: `CLAUDE.md`, local memory, and auto memory make project conventions available across sessions.
- Extensibility: slash commands, local skills, hooks, local MCP-style servers, output styles, and focused workers allow the harness to grow without hardcoding every workflow into the core loop.
- IDE integration: the editor surface is not just chat. It includes inline diffs, selected-context sharing, conversation history, plan review, and visual review of edits.

## CodeForge Parity Architecture

- Session engine: persist message, tool-call, approval, checkpoint, and command-output records to JSONL, with resume/fork support.
- Tool registry: replace ad hoc actions with a typed registry that supports read, grep, glob, edit, write, bash, diagnostics, git, local protocol, task, ask-user, and focused worker tools.
- Permission engine: add rules with deny -> ask -> allow precedence, scoped by user/workspace/project, with modes equivalent to default, accept-edits, plan, auto, dont-ask, and bypass-with-circuit-breakers.
- Context engine: track itemized context costs, show a `/context` breakdown, defer large tool schemas, and compact older tool outputs before summarizing the session.
- Memory engine: load project instructions from `CODEFORGE.md` plus optional `CLAUDE.md` compatibility, and save explicit user-approved memories.
- Command system: implement built-ins (`/config`, `/permissions`, `/model`, `/context`, `/memory`, `/compact`, `/clear`, `/resume`, `/init`, `/doctor`, `/diff`) and file-backed custom commands.
- Extension system: support skills and hooks as plain local files with frontmatter, plus local protocol server definitions.
- Subagents: run isolated context workers for exploration, planning, review, and implementation, returning summaries to the main session.

## Immediate CodeForge Delta

- Implemented now: endpoint model discovery, selected-model setting, bottom-pinned composer, settings panel, status bar, context usage ring, itemized `/context`, `CODEFORGE.md`/`CLAUDE.md` loading, explicit local `/memory`, model-driven `/compact`, deterministic old-tool-output compaction, typed local tools, diagnostics/fix-diagnostics flow, permission modes/rules, bounded/stoppable shell execution, JSONL session persistence, resume/fork/history/export commands, checkpoints before approved edits and commands, workspace-local slash commands, local skills, and permission-gated local hooks.
- Next priority: tracked background tasks, local protocol tools, worker isolation, and deeper code-intelligence tools.

## Public References

- https://code.claude.com/docs/en/how-claude-code-works
- https://code.claude.com/docs/en/context-window
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/commands
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/hooks
