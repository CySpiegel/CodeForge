// CodeForge speaks two endpoint protocols: the OpenAI-compatible Chat Completions API (the default,
// for vLLM/LiteLLM/LM Studio/llama.cpp and any OpenAI-shaped gateway) and the native Anthropic Messages
// API. Rather than add a separate setting, the protocol is INFERRED from the configured base URL, in
// three ways (any match → Anthropic):
//   1. HOST — api.anthropic.com / any *.anthropic.com (the official API).
//   2. PATH — the base path ends in `/anthropic`, which is how Anthropic-compatible gateways expose the
//      Messages API (e.g. AskSage's https://api.asksage.ai/server/anthropic). The path is preserved as
//      part of the request URL, not stripped.
//   3. FRAGMENT — a `#anthropic` fragment, the opt-in for a local server/proxy that serves BOTH
//      protocols on the same origin+path and so can't be told apart otherwise (e.g. LM Studio:
//      http://localhost:1234#anthropic). The fragment is dropped before building request URLs.

export type ProviderKind = "openai" | "anthropic";

export function resolveProviderKind(baseUrl: string): ProviderKind {
  try {
    const url = new URL(baseUrl.trim());
    const host = url.hostname.toLowerCase();
    if (host === "anthropic.com" || host.endsWith(".anthropic.com")) {
      return "anthropic";
    }
    if (url.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/anthropic")) {
      return "anthropic";
    }
    if (url.hash.replace(/^#/, "").toLowerCase() === "anthropic") {
      return "anthropic";
    }
  } catch {
    // An unparseable base URL falls through to the OpenAI default; the request layer surfaces the bad
    // URL when a turn is actually attempted.
  }
  return "openai";
}
