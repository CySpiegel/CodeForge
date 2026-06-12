import { LlmProvider, LlmRequest, LlmStreamEvent } from "../core/types";

const defaultModelStreamIdleTimeoutMs = 300_000;
const statusIntervalMs = 10_000;

export interface IdleTimeoutOptions {
  readonly idleTimeoutMs: number;
  // Called with human-readable progress while waiting (heartbeats and rate-limit backoff notices).
  readonly onStatus: (text: string) => void;
}

// Wrap a provider stream with an idle-timeout watchdog. Emits periodic "still waiting" heartbeats,
// translates the adapter's rateLimit backoff events into status notices, aborts if the model stalls
// past idleTimeoutMs, and otherwise passes content/tool-call events straight through.
export async function* streamWithIdleTimeout(
  provider: LlmProvider,
  request: LlmRequest,
  abort: AbortController,
  purpose: string,
  options: IdleTimeoutOptions
): AsyncIterable<LlmStreamEvent> {
  const { idleTimeoutMs, onStatus } = options;
  const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
  let lastActivityAt = Date.now();

  try {
    let nextResult = iterator.next();
    while (true) {
      if (abort.signal.aborted) {
        throw new Error(`${purpose} was stopped.`);
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      const remainingBeforeTimeoutMs = Math.max(1, idleTimeoutMs - (Date.now() - lastActivityAt));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new Error(`${purpose} timed out because the model stream was idle for ${formatDuration(idleTimeoutMs)}.`));
        }, remainingBeforeTimeoutMs);
      });
      const heartbeatPromise = new Promise<"heartbeat">((resolve) => {
        heartbeat = setTimeout(() => resolve("heartbeat"), statusIntervalMs);
      });

      let result: IteratorResult<LlmStreamEvent> | "heartbeat";
      try {
        result = await Promise.race([nextResult, timeoutPromise, heartbeatPromise]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (heartbeat) {
          clearTimeout(heartbeat);
        }
      }

      if (result === "heartbeat") {
        const idleMs = Date.now() - lastActivityAt;
        const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
        onStatus(`${purpose} still waiting on ${provider.profile.label}: ${formatDuration(idleMs)} idle, ${formatDuration(remainingMs)} before timeout.`);
        continue;
      }

      if (result.done) {
        return;
      }
      lastActivityAt = Date.now();
      nextResult = iterator.next();
      if (result.value.type === "rateLimit") {
        // The adapter is backing off a 429 (tokens-per-minute) / transient error. Surface it so the
        // user knows the run paused on purpose and will resume — not that it hung.
        const seconds = Math.max(1, Math.round(result.value.waitMs / 1000));
        onStatus(`Rate limit reached (tokens/min) — waiting ${seconds}s, then retrying (attempt ${result.value.attempt}).`);
        continue;
      }
      yield result.value;
    }
  } catch (error) {
    void iterator.return?.().catch(() => undefined);
    throw error;
  }
}

export function modelStreamIdleTimeoutMs(configuredSeconds: number): number {
  const configured = Number(process.env.CODEFORGE_MODEL_STREAM_IDLE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(10, Math.floor(configured));
  }
  if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
    return Math.max(30_000, Math.floor(configuredSeconds * 1000));
  }
  return defaultModelStreamIdleTimeoutMs;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}
