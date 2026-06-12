// Generic transient-HTTP-failure backoff: retry 429 (rate limit) + 5xx with Retry-After-aware delays.
// OpenAI-agnostic — usable by any HTTP caller. The adapter's streamChat runs its own inline loop (so it
// can yield progress) but shares these primitives; non-streaming requests use fetchWithRateLimitRetry.

// Total backoff bounds for transient (429 / 5xx) request failures.
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

export function resolveMaxRateLimitRetries(option: number | undefined): number {
  if (typeof option === "number" && Number.isFinite(option) && option >= 0) {
    return Math.min(Math.floor(option), 20);
  }
  const configured = Number(process.env.CODEFORGE_OPENAI_RATE_LIMIT_RETRIES);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(Math.floor(configured), 20);
  }
  return DEFAULT_MAX_RATE_LIMIT_RETRIES;
}

// HTTP 429 (rate limit, e.g. a LiteLLM tokens-per-minute cap) and 5xx server errors are transient
// and worth retrying with backoff. Non-429 4xx client errors are surfaced immediately.
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || (status >= 500 && status < 600);
}

// Run a one-shot fetch, retrying transient failures with backoff. Used by non-streaming requests
// (model discovery, capability probes); streamChat has its own inline loop so it can yield progress.
export async function fetchWithRateLimitRetry(
  attemptFetch: () => Promise<Response>,
  maxRetries: number,
  signal?: AbortSignal
): Promise<Response> {
  let retries = 0;
  for (;;) {
    const response = await attemptFetch();
    if (response.ok || !isRetryableHttpStatus(response.status) || retries >= maxRetries || signal?.aborted) {
      return response;
    }
    retries++;
    await abortableDelay(rateLimitDelayMs(response.headers, retries), signal);
  }
}

// Wait before the next attempt: honor a Retry-After (or x-ratelimit-reset) hint from the endpoint
// when present, otherwise exponential backoff with jitter, capped at RATE_LIMIT_MAX_DELAY_MS.
export function rateLimitDelayMs(headers: Headers, attempt: number): number {
  const hinted = parseRetryAfterMs(headers);
  if (hinted !== undefined) {
    return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(0, hinted));
  }
  const exponential = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * RATE_LIMIT_BASE_DELAY_MS;
  return Math.min(RATE_LIMIT_MAX_DELAY_MS, exponential + jitter);
}

// Retry-After is delta-seconds or an HTTP-date (RFC 7231). LiteLLM/OpenAI gateways also expose
// retry-after-ms and x-ratelimit-reset-* hints. Returns milliseconds, or undefined when no usable
// hint is present.
function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1_000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }
  for (const key of ["retry-after-ms", "x-ratelimit-reset-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset"]) {
    const raw = headers.get(key);
    if (!raw) {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      // *-ms hints are already milliseconds; the reset-* hints are seconds.
      return key.endsWith("-ms") ? value : value * 1_000;
    }
  }
  return undefined;
}

// Resolve after `ms`, or early (without rejecting) if the signal aborts — the next fetch then
// surfaces the real AbortError, matching how the rest of the adapter handles cancellation.
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
