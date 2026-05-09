# CodeForge

CodeForge is a clean-room Visual Studio Code coding harness extension for local and on-prem OpenAI-compatible LLM endpoints.

The default posture is local and private:

- no telemetry
- no cloud provider presets
- strict network policy that allows localhost and private IP ranges by default
- public IP destinations blocked even when configured by mistake
- explicit approval before applying edits or running shell commands

## Supported v1 endpoints

- LiteLLM proxy: `http://127.0.0.1:4000/v1`
- vLLM OpenAI-compatible server: `http://127.0.0.1:8000/v1`
- on-prem LiteLLM or vLLM-compatible `/v1` endpoints reachable on private network hostnames you explicitly configure

## Development

```bash
npm install
npm run compile
npm test
npm run vscode:test
npm run package
```

Open the project in VS Code and run the extension host launch configuration, or use the `CodeForge: Open Chat` command after installation.

Chat commands include `/new`, `/context`, `/commands`, `/skills`, `/skill`, `/memory`, `/compact`, `/clear`, `/stop`, `/history`, `/resume`, `/fork`, `/diff`, `/export`, `/model`, and `/config`. Session records, exports, and explicit memories stay in local VS Code storage. Project instructions are loaded from `CODEFORGE.md`, with optional `CLAUDE.md` compatibility. CodeForge starts with a clean active chat on reload; use `/history` to open workspace chat history and `/resume` to restore an older session.

Approved shell commands run in the workspace with a scrubbed environment, a configurable timeout, and bounded stdout/stderr retention. Background shell operators are rejected until they can be tracked as explicit local tasks.

Workspace-local extensions live under `.codeforge/`: markdown slash commands in `.codeforge/commands/`, markdown skills in `.codeforge/skills/`, and permission-gated hooks in `.codeforge/hooks.json`.

Editor commands include ask, edit, explain, generate-tests, and fix-diagnostics flows for the current selection or file. CodeForge also exposes current VS Code diagnostics as a local read-only model tool.

See `ARCHITECTURE.md` for the design boundaries and patterns used in the implementation.
See `docs/claude-code-clean-room-parity.md` for the clean-room Claude Code parity review and roadmap.
See `docs/roadmap.md` for the VS Code-native Harnes parity roadmap.
See `docs/local-extensions.md` for local command, skill, and hook formats.

## Source Boundary

CodeForge is not based on copied Claude Code source. Public Claude Code source leak repositories are treated only as product research references because they do not provide a usable open-source license.
