# CodeForge Architecture

CodeForge uses a ports-and-adapters layout so the coding harness stays testable and self-hosted endpoint support remains first class.

## Boundaries

- `src/core`: provider contracts, network policy, SSE parsing, context budgeting, action parsing, approval state, and patch parsing. This layer has no VS Code imports.
- `src/adapters`: VS Code, filesystem, terminal, configuration, secrets, and diff-preview adapters.
- `src/agent`: orchestration of prompts, local context, endpoint calls, local tool loops, approvals, and execution.
- `src/ui`: sidebar webview provider and message bridge.
- `media`: webview JavaScript, CSS, and icon assets.

## Patterns

- Adapter pattern: self-hosted LLM endpoints, VS Code workspace APIs, terminal execution, and diff previews are isolated behind small interfaces.
- Strategy pattern: endpoint behavior, context collection, and native-tool-call versus JSON-action fallback can evolve without changing UI code.
- Command pattern: model-requested actions are represented as typed command records before execution.
- State machine discipline: sessions move through prompt, streaming, local tool, approval, execution, and idle/error states explicitly.
- Dependency injection: `extension.ts` is the composition root; core modules do not reach into global VS Code state.

## Design Rules

- No Claude Code source is copied into this project.
- Runtime dependencies are avoided unless they remove real complexity.
- Public network access is blocked by default except localhost/private IPs and explicit allowlist entries.
- File writes and shell commands require user approval.
- Model responses and local action requests are parsed through typed, validated boundaries before use.
