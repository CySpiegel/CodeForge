import { ModelInfo } from "./types";

// Default per-turn output cap (tokens), matching Claude Code's ~32k generous default. Used when
// codeforge.model.maxOutputTokens is left at its default. Must stay in sync with the package.json
// default for that setting.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const MIN_OUTPUT_TOKENS = 512;

// Decide the max_tokens to send for a model turn from the user's preference:
//   preference <= 0 -> no limit: return undefined so no max_tokens is sent and the endpoint/model
//                      decides (on vLLM, up to the remaining context window).
//   preference > 0  -> cap output at that many tokens, but never above half the context window (so
//                      the prompt always has room) nor above the model's reported output limit.
//                      The default (DEFAULT_MAX_OUTPUT_TOKENS) flows through this same safe bounding,
//                      which keeps it sane on small-context models and overrides the tiny built-in
//                      defaults of some vLLM/LiteLLM deployments that truncate tool-call JSON.
export function resolveRequestMaxTokens(
  model: ModelInfo | undefined,
  contextLimitMaxTokens?: number,
  preference = DEFAULT_MAX_OUTPUT_TOKENS
): number | undefined {
  if (preference <= 0) {
    return undefined;
  }
  const bounds = [Math.floor(preference)];
  const context = model?.contextLength ?? contextLimitMaxTokens;
  if (context && context > 0) {
    bounds.push(Math.floor(context / 2));
  }
  if (model?.maxOutputTokens && model.maxOutputTokens > 0) {
    bounds.push(model.maxOutputTokens);
  }
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(...bounds));
}
