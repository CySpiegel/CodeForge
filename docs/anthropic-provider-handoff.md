# Anthropic Provider — Handoff

Native Anthropic Messages API support for CodeForge. This document captures the Phase 1 implementation
state, how to connect, the (substantial) research on reasoning/"reflect-back" behavior across providers,
and the prioritized pending work.

## Status

**Phase 1 is implemented, committed, and validated against a live LM Studio Anthropic endpoint.** It is
**not** yet validated against real `api.anthropic.com` / AskSage (no key/token was available during the
build session). Committed but **not released** — CHANGELOG entry sits under `[Unreleased]`, version
stays `0.3.0` until a release bump.

Commits:
- `b5a92c8` feat(provider): native Anthropic Messages API support (Phase 1)
- `846db6b` feat(anthropic): surface stop_reason refusal + full-loop integration test

## What works (Phase 1)

- `AnthropicMessagesProvider` implements the existing `LlmProvider` interface — the agent loop, context
  management, workers, and doctor are unchanged.
- Streaming chat over the native SSE format (`message_start` / `content_block_delta` with
  `input_json_delta` tool-arg reassembly / `message_delta` / `message_stop`) → CodeForge's existing
  `LlmStreamEvent` sequence.
- Native tool calls (assistant `tool_use` ⇄ user `tool_result`), required `max_tokens`, usage merge.
- `stop_reason: "refusal"` surfaces an explanatory note instead of an empty turn.
- Model discovery: `GET /v1/models` (`max_input_tokens`→contextLength, `max_tokens`→maxOutputTokens),
  with a Claude fallback catalogue and an embedding-model filter.
- Zero runtime dependencies (raw `fetch`). 368 deterministic tests pass.
- **Live-validated** against LM Studio's Anthropic endpoint: streamed text + native tool calls + the full
  two-turn agentic tool loop (tool result round-trips into a `tool_result` block).

## How to connect (protocol inferred from the base URL — no setting)

| Target | Base URL | Auth header sent |
|---|---|---|
| Official Anthropic | `https://api.anthropic.com` | `x-api-key: <key>` |
| AskSage | `https://api.asksage.ai/server/anthropic` | `Authorization: Bearer <token>` |
| Local / proxy (e.g. LM Studio) | `http://127.0.0.1:1234#anthropic` | `Authorization: Bearer` |

- `resolveProviderKind` (`src/core/providerKind.ts`) selects the Anthropic protocol when the base URL
  host is `*.anthropic.com`, **or** the path ends in `/anthropic` (AskSage and similar gateways — the
  path is preserved, not stripped), **or** there's a `#anthropic` fragment (a local server that also
  serves an OpenAI API on the same origin).
- Auth is host-based: `*.anthropic.com` → `x-api-key`; everything else → `Authorization: Bearer`.
  `anthropic-version: 2023-06-01` is always sent. `profile.extraHeaders` overrides.

## Files

- `src/core/anthropicAdapter.ts` — the provider: headers, base-URL normalizer, `streamChat` (SSE →
  events, refusal note), `inspectEndpoint` (`/v1/models` + fallback + embedding filter), `listModels`,
  `probeCapabilities` (static).
- `src/core/anthropicMessageMapper.ts` — system-prompt hoist, `role:"tool"` → coalesced user
  `tool_result` blocks, assistant `toolCalls` → `tool_use` blocks (parsed object input), reuses the
  OpenAI orphan/duplicate tool-call repair, leading-user enforcement, `toAnthropicTool`.
- `src/core/anthropicModelCatalog.ts` — `parseAnthropicModels`, `ANTHROPIC_MODEL_FALLBACK`,
  `withAnthropicFallback`, `resolveAnthropicMaxTokens`.
- `src/core/providerKind.ts` — protocol inference.
- `src/agent/providerGateway.ts:createProvider` — dispatches on the inferred kind.
- `src/core/types.ts` — `OpenAiBackendKind` gains `"anthropic"`; `src/core/openaiModelDiscovery.ts` —
  `backendLabel` case.
- Tests: `test/unit/anthropicAdapter.test.ts`, `anthropicMessageMapper.test.ts`,
  `anthropicModelCatalog.test.ts`, `providerKind.test.ts`; `test/integration/anthropicProviderLoop.test.ts`.

## Key research: the reasoning / "reflect-back" landscape

The big design fact, established by docs + live probing this session. **Reflect the model's reasoning
back to the API only on the assistant turn that made a tool call** — so the model continues its reasoning
into the tool result. It is *not* needed on plain (non-tool) turns. The mechanism is per-provider:

| Provider / surface | Carrier on the tool-call turn | Reflect back? |
|---|---|---|
| Anthropic Messages | `thinking` block + `signature` | **yes** |
| OpenAI **Responses** API | reasoning items / `previous_response_id` | **yes** |
| DeepSeek V4 (Chat Completions / OpenRouter) | `reasoning_content` | **yes** |
| OpenRouter (any strict model) | `reasoning_details` (or `reasoning`) | **yes** |
| Gemini 3 | `thought_signature` on `functionCall` | **yes** |
| OpenAI **Chat Completions** / LM Studio / older models | — | **no** |

Verified specifics:
- **LM Studio's Anthropic endpoint strips reasoning.** Raw `curl` to `/v1/messages` (qwen, gemma) shows
  only `text` content blocks + `text_delta` — no `thinking`/`signature`/`reasoning_content`. Local
  reasoning models surface their CoT only on LM Studio's **OpenAI** endpoint, as `reasoning_content`,
  which CodeForge's OpenAI adapter already routes to the thinking block. (So for a local reasoning
  model, the OpenAI endpoint is the right path; the Anthropic endpoint loses thinking.)
- **LM Studio is lenient on multi-turn:** a turn that omits the prior `reasoning_content` returns HTTP
  200 — no reflect-back enforced.
- **OpenAI Chat Completions** (what CodeForge talks to) discards reasoning between turns — no reflect-back
  requirement. CodeForge → OpenAI works as-is.
- **The reject-vs-require split:** DeepSeek **R1** returns 400 if you *do* echo `reasoning_content`;
  DeepSeek **V4** returns 400 if you *don't* (on tool turns). So CodeForge cannot blanket "always" or
  "never" — reflect-back must be applied per provider/model.

Thinking on/off (from the authoritative Claude API reference):
- **Fable 5:** thinking is **always on** — `{type:"disabled"}` → 400; you omit the param. Can't be
  disabled. (And its tool-turn replay is strictly enforced — see pending #1.)
- **Opus 4.8 / 4.7 / 4.6, Sonnet 4.6:** thinking is **off by default** — enable with
  `thinking:{type:"adaptive"}`; can be disabled. So a "thinking" setting is effectively an *enable*
  switch (a no-op on Fable 5).

## Pending work (prioritized)

1. **Reasoning reflect-back (the core gap).** CodeForge treats reasoning as display-only and **drops it**
   from the transcript (`agentController.ts:1166`). This **breaks agentic (tool) loops on every strict
   provider** — Anthropic thinking, DeepSeek V4, OpenRouter, Gemini 3 — because the reasoning isn't
   echoed on the tool-call turn. Fix: store the reasoning (text + provider `signature`/details) on the
   assistant `ChatMessage` when it carries tool calls, and replay it in the next request, formatted per
   protocol (Anthropic: `thinking` block + signature; OpenAI/DeepSeek: `reasoning_content`; OpenRouter:
   `reasoning_details`). Touches `ChatMessage`, `LlmRequest`, both adapters + mappers, and the agent
   loop. **Untestable without a strict endpoint** (LM Studio is lenient and strips thinking).
2. **Request thinking (Phase 2 enable).** Add `codeforge.model.thinking` (off | adaptive, default off);
   the Anthropic adapter sends `thinking:{type:"adaptive"}` when on (OpenAI adapter ignores it). Required
   for Opus/Sonnet to think at all. Pairs with #1 for tool turns.
3. **OAuth auth mode (use a Claude subscription).** A Claude Pro/Max subscription does **not** include
   API-key credits (separate billing), but Agent-SDK/third-party usage via **OAuth** draws on the
   subscription (the June-2026 billing split was paused). To use it, the adapter needs
   `Authorization: Bearer <oauth-token>` **plus** `anthropic-beta: oauth-2025-04-20` (token via
   `ant auth` / Claude Code OAuth; short-lived, needs refresh). This is also a way to get a **real
   Anthropic endpoint to validate against** without buying API credits.
4. **Live validation** against real Anthropic / AskSage / OpenRouter (needs a key or token). **OpenRouter
   with one key serves Anthropic + DeepSeek V4 + Gemini 3** — the ideal strict endpoint to build and
   verify reflect-back against.
5. **Docs + release.** README already updated; add a `docs/user-guide.md` Anthropic section. At release,
   move CHANGELOG `[Unreleased]` → `[0.4.0]`, bump `package.json`, tag.
6. **Phase 3:** prompt caching (`cache_control` + cache usage telemetry), vision/PDF (needs
   `ChatMessage.content` beyond a plain string — an architectural change), configurable
   `anthropic-version` / `anthropic-beta` headers in the settings UI.

## Known limitations (current build)

- Reasoning is display-only/dropped → agentic loops with a thinking model on a strict provider would
  fail (pending #1).
- Thinking is not requested → Opus/Sonnet won't think; Fable 5 thinks but its tool-turn replay would
  break (pending #1).
- No vision/PDF, no prompt caching.
- LM Studio's Anthropic endpoint strips reasoning (its limitation, not CodeForge's).

## Session test endpoints

- LM Studio at `http://127.0.0.1:1234` — models `qwen/qwen3.6-35b-a3b`, `google/gemma-4-31b`,
  `google/gemma-4-26b-a4b`, `google/gemma-4-e4b`. Anthropic protocol via a `#anthropic` base-URL
  fragment (or raw `/v1/messages`). A standalone smoke script lived at
  `…/scratchpad/anthropic-smoke.js` (not committed).
