# CodeForge Architecture

CodeForge uses a ports-and-adapters layout so the coding harness stays testable and self-hosted endpoint support remains first class.

## Boundaries

- `src/core`: provider contracts, network policy, SSE parsing, context budgeting, local memory contracts, action parsing, approval state, and patch parsing. This layer has no VS Code imports.
  - Learning core (`learning.ts`, `skillProposal.ts`, `agentProposal.ts`, `learningAudit.ts`): pure lesson (de)serialization over `MemoryEntry`, extraction/proposal prompts with tolerant parsers, relevance ranking, the bounded context digest, and the self-audit dedup/prune plan. No VS Code imports — the agent layer drives the model calls and file writes.
  - Sub-agent definitions (`workerAgents.ts`, `workerTypes.ts`): the built-in worker kinds (`explore`, `plan`, `review`, `verify`, `implement`) with their bounded toolsets, plus `custom` for `.codeforge/agents` definitions. No VS Code imports.
  - Persona/voice loading lives in `localExtensions.ts` (`loadLocalSoul`, alongside the loaders for local commands, skills, and agents).
- `src/adapters`: VS Code, filesystem, terminal, configuration, secrets, local memory/session storage, and diff-preview adapters. `worktree.ts` (`GitWorktreeManager`) is a Git worktree isolation adapter for parallel editing sub-agents — built and tested, but not yet wired into the worker runtime.
- `src/agent`: orchestration of prompts, local context, endpoint calls, local tool loops, approvals, and execution. `workerManager.ts` runs sub-agents under a concurrency cap (`codeforge.workers.maxConcurrent`, default 3) with a start-as-others-finish queue, and is lesson/skill-aware so workers inherit relevant learned context.
- `src/ui`: VS Code sidebar view provider and message bridge.
- `media`: VS Code extension-view JavaScript, CSS, and icon assets.

## Patterns

- Adapter pattern: self-hosted LLM endpoints, VS Code workspace APIs, terminal execution, and diff previews are isolated behind small interfaces.
- Strategy pattern: endpoint behavior, context collection, and native-tool-call versus JSON-action fallback can evolve without changing UI code.
- Command pattern: model-requested actions are represented as typed command records before execution.
- State machine discipline: sessions move through prompt, streaming, local tool, approval, execution, and idle/error states explicitly.
- Event sourcing: sessions persist append-only JSONL records for messages, approvals, checkpoints, and resumable transcript replay.
- Dependency injection: `extension.ts` is the composition root; core modules do not reach into global VS Code state.

## Design Rules

- No Claude Code source is copied into this project.
- Runtime dependencies are avoided unless they remove real complexity.
- Public IP network access is blocked. CodeForge permits localhost, private IP ranges, and explicitly configured on-prem hostnames for vLLM/LiteLLM-compatible endpoints.
- File writes and shell commands require user approval.
- Shell commands run through the terminal adapter with workspace-scoped cwd validation, bounded output, cancellation, and a minimized environment.
- Local memories are written only through approval-gated paths: the user's `/memory` command, the approval-gated `memory_write` tool, and — when learning autonomy permits — automatically saved learned lessons. Nothing is written to memory silently outside these.
- Model responses and local action requests are parsed through typed, validated boundaries before use.
- The learning loop is fire-and-forget and fully guarded: it runs only after a finished task and must never block or break a run.
- Learned skill and agent files are written only through the approval path (`diff.applyWriteFile`); they are never written silently.
- Agent definitions are never auto-written — proposed sub-agents stay review-only and require explicit acceptance even under `learning.autonomy: auto`.
