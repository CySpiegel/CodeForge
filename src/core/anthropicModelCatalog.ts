import { isRecord } from "./guards";
import { ModelInfo } from "./types";

// Anthropic model discovery + sizing. The native Messages API differs from the OpenAI-compatible
// discovery in two ways CodeForge cares about: the context window is `max_input_tokens` (NOT
// context_window / n_ctx / max_model_len) and the output cap is `max_tokens` (which on OpenAI backends
// means a CONTEXT field — so the OpenAI parser cannot be reused here). Older API versions return only
// { id, display_name, created_at } with no token fields; those models get their sizes from the
// fallback table below. All current Claude models support extended thinking.

// Per-model context/output sizes used when GET /v1/models is unreachable (no key yet, offline) or omits
// the token fields. Keep in sync with the published Claude model lineup.
export const ANTHROPIC_MODEL_FALLBACK: readonly ModelInfo[] = [
  { id: "claude-opus-4-8", contextLength: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true },
  { id: "claude-opus-4-7", contextLength: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true },
  { id: "claude-opus-4-6", contextLength: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true },
  { id: "claude-sonnet-4-6", contextLength: 1_000_000, maxOutputTokens: 64_000, supportsReasoning: true },
  { id: "claude-haiku-4-5", contextLength: 200_000, maxOutputTokens: 64_000, supportsReasoning: true },
  { id: "claude-fable-5", contextLength: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true }
];

// Output cap used when neither the request nor the model's discovered/fallback metadata gives one.
// Mirrors the OpenAI path's DEFAULT_MAX_OUTPUT_TOKENS so behavior matches across providers.
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 32_000;

// Turn a GET /v1/models body into ModelInfo[]: max_input_tokens -> contextLength, max_tokens ->
// maxOutputTokens. Models lacking those fields keep them undefined here and are filled from the
// fallback table by withAnthropicFallback.
export function parseAnthropicModels(body: unknown): readonly ModelInfo[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return [];
  }
  return body.data
    .map((model): ModelInfo | undefined => {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        return undefined;
      }
      return {
        id: model.id,
        contextLength: positiveInteger(model.max_input_tokens),
        maxOutputTokens: positiveInteger(model.max_tokens),
        supportsReasoning: true
      };
    })
    .filter((model): model is ModelInfo => Boolean(model));
}

// Merge discovered models with the fallback table: fill any missing contextLength/maxOutputTokens from
// the table by id, and — when discovery returned nothing usable — surface the fallback catalogue so the
// model picker is never empty (e.g. before a valid key is saved, or against an endpoint without a
// /v1/models listing).
export function withAnthropicFallback(discovered: readonly ModelInfo[]): readonly ModelInfo[] {
  const fallbackById = new Map(ANTHROPIC_MODEL_FALLBACK.map((model) => [model.id, model]));
  const merged = discovered.map((model) => {
    const fallback = fallbackById.get(model.id);
    if (!fallback) {
      return model;
    }
    return {
      ...model,
      contextLength: model.contextLength ?? fallback.contextLength,
      maxOutputTokens: model.maxOutputTokens ?? fallback.maxOutputTokens
    };
  });
  return merged.length > 0 ? merged : ANTHROPIC_MODEL_FALLBACK;
}

// Anthropic requires `max_tokens` on every request and it bounds OUTPUT only. The agent already bounds
// the user's preference (resolveRequestMaxTokens, which may be undefined = "no cap") before it reaches
// the provider; coerce that into a concrete positive integer, clamped to the model's output cap when
// known, so the request is always well-formed.
export function resolveAnthropicMaxTokens(model: ModelInfo | undefined, requestMaxTokens: number | undefined): number {
  const requested = requestMaxTokens && requestMaxTokens > 0
    ? Math.floor(requestMaxTokens)
    : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS;
  const cap = model?.maxOutputTokens && model.maxOutputTokens > 0 ? model.maxOutputTokens : undefined;
  return cap ? Math.max(1, Math.min(requested, cap)) : Math.max(1, requested);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
