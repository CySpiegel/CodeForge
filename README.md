# CodeForge

CodeForge is a clean-room Visual Studio Code coding harness extension for self-hosted OpenAI-compatible LLM endpoints.

The default posture is local and private:

- no telemetry
- no cloud provider presets
- strict network policy that allows localhost and private IP ranges by default
- explicit approval before applying edits or running shell commands

## Supported v1 endpoints

- LiteLLM proxy: `http://127.0.0.1:4000/v1`
- vLLM OpenAI-compatible server: `http://127.0.0.1:8000/v1`
- any custom OpenAI-compatible `/v1` endpoint that is reachable under the configured network policy

## Development

```bash
npm install
npm run compile
npm test
npm run vscode:test
npm run package
```

Open the project in VS Code and run the extension host launch configuration, or use the `CodeForge: Open Chat` command after installation.

See `ARCHITECTURE.md` for the design boundaries and patterns used in the implementation.

## Source Boundary

CodeForge is not based on copied Claude Code source. Public Claude Code source leak repositories are treated only as product research references because they do not provide a usable open-source license.
