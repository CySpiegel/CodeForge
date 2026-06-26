import { abortableDelay, fetchWithRateLimitRetry, isRetryableHttpStatus, rateLimitDelayMs, resolveMaxRateLimitRetries } from "./httpRetry";
import { assertUrlAllowed } from "./networkPolicy";
import { ensureOpenAiToolResultPairing, toOpenAiMessage, toOpenAiTool } from "./openaiMessageMapper";
import { backendLabel, detectBackend, isEmbeddingModel, modelsFromBody } from "./openaiModelDiscovery";
import { SseParser } from "./sseParser";
// Re-exported so existing import paths (contextManager, openaiAdapter.test) keep working after the split.
export { sanitizeToolArgumentsJson } from "./openaiToolArgs";
export { resolveRequestMaxTokens } from "./openaiMaxTokens";
export { ensureOpenAiToolResultPairing } from "./openaiMessageMapper";
import {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  NetworkPolicy,
  OpenAiEndpointInspection,
  ProviderCapabilities,
  ProviderProfile,
  TokenUsage,
  ToolCall
} from "./types";

interface OpenAiStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string;
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly OpenAiToolCallDelta[];
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: OpenAiUsage | null;
}

interface OpenAiUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface OpenAiToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface OpenAiToolCallState {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface OpenAiProviderOptions {
  readonly streamCompletionGraceMs?: number;
  readonly streamQuietExtensions?: number;
  // How many times a request that fails with HTTP 429 (rate limit) or 5xx is retried with backoff
  // before the error is surfaced. Defaults to DEFAULT_MAX_RATE_LIMIT_RETRIES.
  readonly maxRateLimitRetries?: number;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly profile: ProviderProfile;
  private readonly policy: NetworkPolicy;
  private readonly options: OpenAiProviderOptions;

  constructor(profile: ProviderProfile, policy: NetworkPolicy, options: OpenAiProviderOptions = {}) {
    this.profile = profile;
    this.policy = policy;
    this.options = options;
  }

  async *streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const url = this.endpoint("chat/completions");
    assertUrlAllowed(url, this.policy);

    const maxRateLimitRetries = resolveMaxRateLimitRetries(this.options.maxRateLimitRetries);
    let includeUsage = true;
    let rateLimitRetries = 0;
    let response: Response;
    for (;;) {
      response = await this.fetchChatStream(url, request, includeUsage);
      if (response.ok) {
        break;
      }
      // A non-429 4xx is almost always the endpoint rejecting an optional request field (most often
      // `stream_options`); drop it once and retry before giving up. This stays separate from the
      // rate-limit path below so a 429 is never mistaken for an unsupported-field 400.
      if (response.status >= 400 && response.status < 500 && response.status !== 429 && includeUsage) {
        includeUsage = false;
        continue;
      }
      // HTTP 429 (e.g. a LiteLLM tokens-per-minute limit) and 5xx are transient. Honor a Retry-After
      // hint when present, otherwise back off exponentially with jitter, then retry instead of
      // failing the whole turn. This is the fix for the "ran out of tokens" report: a per-minute rate
      // limit is not a context-window or token-budget error.
      if (isRetryableHttpStatus(response.status) && rateLimitRetries < maxRateLimitRetries && !request.signal?.aborted) {
        rateLimitRetries++;
        const waitMs = rateLimitDelayMs(response.headers, rateLimitRetries);
        // Tell the UI we hit the limit and are waiting, so the user sees why the run paused.
        yield { type: "rateLimit", waitMs, attempt: rateLimitRetries };
        await abortableDelay(waitMs, request.signal);
        continue;
      }
      throw new Error(rateLimitAwareErrorMessage(response.status, await safeResponseText(response), rateLimitRetries));
    }
    if (!response.body) {
      throw new Error("Endpoint did not return a stream body.");
    }

    const decoder = new TextDecoder();
    const parser = new SseParser();
    const toolCalls = new Map<number, OpenAiToolCallState>();
    const reader = response.body.getReader();
    const streamCompletionGraceMs = resolveStreamCompletionGraceMs(this.options.streamCompletionGraceMs);
    let sawStreamEvent = false;
    let quietExtensionsRemaining = resolveStreamQuietExtensions(this.options.streamQuietExtensions);

    let streamDone = false;
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    try {
      streamLoop:
      while (true) {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        if (!pendingRead) {
          pendingRead = reader.read();
        }
        const readPromise = pendingRead;
        const quietPromise = sawStreamEvent
          ? new Promise<"quiet">((resolve) => {
            quietTimer = setTimeout(() => resolve("quiet"), streamCompletionGraceMs);
          })
          : undefined;
        let readResult: ReadableStreamReadResult<Uint8Array> | "quiet";
        try {
          readResult = quietPromise ? await Promise.race([readPromise, quietPromise]) : await readPromise;
        } finally {
          if (quietTimer) {
            clearTimeout(quietTimer);
          }
        }

        if (readResult === "quiet") {
          if (quietExtensionsRemaining > 0 && hasIncompleteToolCallArgs(toolCalls)) {
            quietExtensionsRemaining--;
            continue;
          }
          await reader.cancel().catch(() => undefined);
          break;
        }
        pendingRead = undefined;
        if (readResult.done) {
          break;
        }

        const text = decoder.decode(readResult.value, { stream: true });
        const events = parser.push(text);
        if (events.length === 0 && text.trim()) {
          sawStreamEvent = true;
          yield { type: "progress" };
        }
        for (const event of events) {
          if (event.data === "[DONE]") {
            streamDone = true;
            break streamLoop;
          }
          sawStreamEvent = true;
          yield* this.parseStreamEvent(event.data, toolCalls);
          if (hasFinishReason(event.data)) {
            streamDone = true;
            break streamLoop;
          }
          if (isTerminalUsageChunk(event.data) && !hasIncompleteToolCallArgs(toolCalls)) {
            streamDone = true;
            break streamLoop;
          }
        }
      }

      if (!streamDone) {
        for (const event of parser.flush()) {
          if (event.data === "[DONE]") {
            streamDone = true;
            break;
          }
          yield* this.parseStreamEvent(event.data, toolCalls);
          if (hasFinishReason(event.data)) {
            streamDone = true;
            break;
          }
          if (isTerminalUsageChunk(event.data) && !hasIncompleteToolCallArgs(toolCalls)) {
            streamDone = true;
            break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const finalToolCalls = [...toolCalls.values()]
      .filter((toolCall) => toolCall.name)
      .map((toolCall): ToolCall => ({
        id: toolCall.id,
        name: toolCall.name,
        argumentsJson: toolCall.argumentsJson
      }));
    if (finalToolCalls.length > 0) {
      yield { type: "toolCalls", toolCalls: finalToolCalls };
    }

    yield { type: "done" };
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    return (await this.inspectEndpoint(signal)).models.map((model) => model.id);
  }

  async inspectEndpoint(signal?: AbortSignal): Promise<OpenAiEndpointInspection> {
    const url = this.endpoint("models");
    assertUrlAllowed(url, this.policy);

    const response = await fetchWithRateLimitRetry(
      () => fetch(url, { headers: this.headers(false), signal }),
      resolveMaxRateLimitRetries(this.options.maxRateLimitRetries),
      signal
    );

    if (!response.ok) {
      throw new Error(`Model discovery failed at ${url}: HTTP ${response.status}: ${await safeResponseText(response)}`);
    }

    const body = await response.json();
    let models = modelsFromBody(body);
    const backend = detectBackend(response.headers, body, models);
    models = models.filter((model) => !isEmbeddingModel(model));
    return {
      backend,
      backendLabel: backendLabel(backend),
      models
    };
  }

  async probeCapabilities(model: string, signal?: AbortSignal): Promise<ProviderCapabilities> {
    const url = this.endpoint("chat/completions");
    assertUrlAllowed(url, this.policy);

    const [models, toolCalls] = await Promise.all([
      this.listModels(signal).then((list) => list.length > 0).catch(() => false),
      this.probeToolCalls(url, model, signal).catch(() => false)
    ]);

    return {
      streaming: true,
      modelListing: models,
      nativeToolCalls: toolCalls
    };
  }

  private async probeToolCalls(url: string, model: string, signal?: AbortSignal): Promise<boolean> {
    const request = {
      model,
      messages: [
        { role: "user", content: "Respond with ok." }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "echo_probe",
            description: "Probe whether the endpoint accepts OpenAI tool schemas.",
            parameters: {
              type: "object",
              properties: {
                value: { type: "string" }
              },
              required: ["value"],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: "none",
      max_tokens: 1,
      temperature: 0
    };

    const maxRateLimitRetries = resolveMaxRateLimitRetries(this.options.maxRateLimitRetries);
    let response = await fetchWithRateLimitRetry(
      () => fetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(request), signal }),
      maxRateLimitRetries,
      signal
    );

    if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 429) {
      const retryRequest: Record<string, unknown> = { ...request };
      delete retryRequest.tool_choice;
      response = await fetchWithRateLimitRetry(
        () => fetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(retryRequest), signal }),
        maxRateLimitRetries,
        signal
      );
    }

    if (!response.ok) {
      return false;
    }

    await response.arrayBuffer().catch(() => undefined);
    return true;
  }

  private *parseStreamEvent(data: string, toolCalls: Map<number, OpenAiToolCallState>): Iterable<LlmStreamEvent> {
    if (data === "[DONE]") {
      return;
    }

    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(data) as OpenAiStreamChunk;
    } catch {
      // A partial or non-JSON SSE frame — e.g. a fragment the parser flushes after a dropped or
      // quiet-cancelled stream, or a gateway keep-alive line — must NOT throw a raw "Unterminated
      // string in JSON at position N" out of streamChat and discard the whole turn. Skip the frame;
      // accumulated content and tool-call deltas are preserved on `toolCalls` across events.
      return;
    }
    const usage = toUsage(chunk.usage);
    if (usage) {
      yield { type: "usage", usage };
    }

    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content;
      if (content) {
        yield { type: "content", text: content };
      }
      if (choice.delta?.reasoning_content) {
        yield { type: "reasoning", text: choice.delta.reasoning_content };
      }

      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const current = toolCalls.get(index) ?? { id: "", name: "", argumentsJson: "" };
        current.id = delta.id ?? current.id;
        current.name = delta.function?.name ?? current.name;
        current.argumentsJson += delta.function?.arguments ?? "";
        toolCalls.set(index, current);
        yield { type: "progress" };
      }
    }
  }

  private headers(json = true): Record<string, string> {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.profile.apiKey ? { Authorization: `Bearer ${this.profile.apiKey}` } : {}),
      ...(this.profile.extraHeaders ?? {})
    };
  }

  private endpoint(path: string): string {
    return `${this.openAiBaseUrl()}/${path}`;
  }

  private openAiBaseUrl(): string {
    const trimmed = this.profile.baseUrl.trim().replace(/\/+$/, "");
    try {
      const url = new URL(trimmed);
      const pathname = url.pathname.replace(/\/+$/, "");
      if (!pathname) {
        url.pathname = "/v1";
      } else if (!pathname.endsWith("/v1")) {
        url.pathname = `${pathname}/v1`;
      } else {
        url.pathname = pathname;
      }
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    } catch {
      return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
    }
  }

  private fetchChatStream(url: string, request: LlmRequest, includeUsage: boolean): Promise<Response> {
    const messages = ensureOpenAiToolResultPairing(request.messages);
    return fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: messages.map(toOpenAiMessage),
        temperature: request.temperature ?? 0.2,
        stream: true,
        ...(request.maxTokens && request.maxTokens > 0 ? { max_tokens: Math.floor(request.maxTokens) } : {}),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toOpenAiTool) } : {})
      }),
      signal: request.signal
    });
  }
}

function toUsage(usage: OpenAiUsage | null | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function hasFinishReason(data: string): boolean {
  try {
    const chunk = JSON.parse(data) as OpenAiStreamChunk;
    return (chunk.choices ?? []).some((choice) => choice.finish_reason !== undefined && choice.finish_reason !== null);
  } catch {
    return false;
  }
}

// The include_usage terminal chunk: with stream_options.include_usage set (which CodeForge requests),
// OpenAI-compatible servers stream a final chunk carrying token usage with an EMPTY choices array,
// just before — or in place of — `data: [DONE]`. Treating it as end-of-stream lets the run finish the
// instant the model is done, instead of waiting out the completion grace for a [DONE] or socket close
// that some gateways (e.g. LiteLLM) delay or omit. That stale wait is what left the UI showing
// "Generating" long after the final message had already arrived.
function isTerminalUsageChunk(data: string): boolean {
  try {
    const chunk = JSON.parse(data) as OpenAiStreamChunk;
    return Boolean(chunk.usage) && (chunk.choices?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

function resolveStreamCompletionGraceMs(optionMs: number | undefined): number {
  if (typeof optionMs === "number" && Number.isFinite(optionMs) && optionMs > 0) {
    return Math.min(Math.max(optionMs, 10), 120_000);
  }
  const configured = Number(process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(configured, 10), 120_000);
  }
  return 30_000;
}

function resolveStreamQuietExtensions(optionCount: number | undefined): number {
  if (typeof optionCount === "number" && Number.isFinite(optionCount) && optionCount >= 0) {
    return Math.min(Math.max(Math.floor(optionCount), 0), 5);
  }
  const configured = Number(process.env.CODEFORGE_OPENAI_STREAM_QUIET_EXTENSIONS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(Math.max(Math.floor(configured), 0), 5);
  }
  return 1;
}

function rateLimitAwareErrorMessage(status: number, body: string, retries: number): string {
  if (status === 429) {
    const attempts = retries > 0 ? ` after ${retries} retr${retries === 1 ? "y" : "ies"}` : "";
    return `Endpoint is rate-limited (HTTP 429)${attempts}. This is a per-minute request/token rate limit on the endpoint or gateway (for example a LiteLLM tokens-per-minute limit) — not a context-window or token-budget error. Wait for the limit to reset, slow the request rate, or raise the limit. Endpoint response: ${body}`;
  }
  return `Endpoint returned HTTP ${status}: ${body}`;
}

function hasIncompleteToolCallArgs(toolCalls: ReadonlyMap<number, OpenAiToolCallState>): boolean {
  for (const toolCall of toolCalls.values()) {
    if (!toolCall.name) {
      continue;
    }
    const args = toolCall.argumentsJson.trim();
    if (args.length === 0) {
      return true;
    }
    try {
      JSON.parse(args);
    } catch {
      return true;
    }
  }
  return false;
}

