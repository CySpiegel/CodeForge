import { assertUrlAllowed } from "./networkPolicy";
import { backendLabel, detectBackend, isEmbeddingModel, modelsFromBody } from "./openaiModelDiscovery";
import { SseParser } from "./sseParser";
import {
  ChatMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  ModelInfo,
  NetworkPolicy,
  OpenAiEndpointInspection,
  ProviderCapabilities,
  ProviderProfile,
  TokenUsage,
  ToolCall,
  ToolDefinition
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

    const chunk = JSON.parse(data) as OpenAiStreamChunk;
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

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? message.name ?? "tool"
    };
  }

  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {})
  };

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: sanitizeToolArgumentsJson(toolCall.argumentsJson)
      }
    }));
  }

  return result;
}

// Local models frequently truncate tool-call arguments mid-string (server-side max_tokens
// cutoff or a quiet-stream timeout). The raw, malformed `argumentsJson` is still recorded on the
// assistant turn so the parse failure surfaces to the model, but it must never be replayed verbatim:
// OpenAI-compatible backends (e.g. LiteLLM) `json.loads` the `arguments` string and reject the whole
// request with HTTP 400 "Unterminated string". Sanitize to valid JSON at the serialization boundary
// so every outbound request is well-formed regardless of how the tool call entered history.
export function sanitizeToolArgumentsJson(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) {
    return "{}";
  }
  if (isJsonObjectString(text)) {
    return text;
  }
  const repaired = repairTruncatedJsonObject(text);
  if (repaired && isJsonObjectString(repaired)) {
    return repaired;
  }
  return "{}";
}

function isJsonObjectString(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// Best-effort completion of a truncated JSON object: close an open string, drop a dangling escape or
// trailing separator, and balance the remaining brackets. Returns undefined when there is nothing to
// repair. Callers must re-validate the result; on failure they fall back to "{}".
function repairTruncatedJsonObject(text: string): string | undefined {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      closers.push("}");
    } else if (ch === "[") {
      closers.push("]");
    } else if (ch === "}" || ch === "]") {
      closers.pop();
    }
  }

  let result = escaped ? text.slice(0, -1) : text;
  if (inString) {
    result += "\"";
  }
  // A trailing object/array separator or dangling key (e.g. `{"a":1,` or `{"a":1,"b"`) cannot be
  // completed into a valid value, so trim it back to the last complete entry before balancing.
  result = result.replace(/,\s*$/, "").replace(/(:\s*|,\s*"[^"]*"\s*)$/, "");
  for (let i = closers.length - 1; i >= 0; i--) {
    result += closers[i];
  }
  return result === text ? undefined : result;
}

export function ensureOpenAiToolResultPairing(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const repaired: ChatMessage[] = [];
  const seenToolCallIds = new Set<string>();
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      index++;
      continue;
    }

    if (message.role === "tool") {
      index++;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) {
      repaired.push(message);
      index++;
      continue;
    }

    const toolCalls = message.toolCalls.filter((toolCall) => {
      if (seenToolCallIds.has(toolCall.id)) {
        return false;
      }
      seenToolCallIds.add(toolCall.id);
      return true;
    });

    if (toolCalls.length === 0) {
      repaired.push({
        role: "assistant",
        content: message.content.trim() ? message.content : "[Duplicate tool calls removed before OpenAI request.]"
      });
      index++;
      continue;
    }

    repaired.push(toolCalls.length === message.toolCalls.length ? message : { ...message, toolCalls });

    const toolMessages: ChatMessage[] = [];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === "tool") {
      toolMessages.push(messages[nextIndex]);
      nextIndex++;
    }

    const usedToolMessageIndexes = new Set<number>();
    for (const toolCall of toolCalls) {
      const matchingIndex = toolMessages.findIndex((toolMessage, toolMessageIndex) =>
        !usedToolMessageIndexes.has(toolMessageIndex) && toolMessage.toolCallId === toolCall.id
      );
      if (matchingIndex >= 0) {
        usedToolMessageIndexes.add(matchingIndex);
        repaired.push(toolMessages[matchingIndex]);
      } else {
        repaired.push({
          role: "tool",
          name: toolCall.name,
          toolCallId: toolCall.id,
          content: `<tool_use_error>Error: Tool call ${toolCall.name} was interrupted before CodeForge produced a result. Continue by inspecting current state before retrying.</tool_use_error>`
        });
      }
    }

    index = nextIndex;
  }

  return repaired;
}

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

function toOpenAiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
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

// Total backoff bounds for transient (429 / 5xx) request failures.
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

function resolveMaxRateLimitRetries(option: number | undefined): number {
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
function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || (status >= 500 && status < 600);
}

// Run a one-shot fetch, retrying transient failures with backoff. Used by non-streaming requests
// (model discovery, capability probes); streamChat has its own inline loop so it can yield progress.
async function fetchWithRateLimitRetry(
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
function rateLimitDelayMs(headers: Headers, attempt: number): number {
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
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
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

