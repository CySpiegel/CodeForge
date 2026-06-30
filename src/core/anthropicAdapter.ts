import { AnthropicRequestParts, toAnthropicRequest } from "./anthropicMessageMapper";
import {
  ANTHROPIC_MODEL_FALLBACK,
  parseAnthropicModels,
  resolveAnthropicMaxTokens,
  withAnthropicFallback
} from "./anthropicModelCatalog";
import { isRecord } from "./guards";
import { abortableDelay, fetchWithRateLimitRetry, isRetryableHttpStatus, rateLimitDelayMs, resolveMaxRateLimitRetries } from "./httpRetry";
import { assertUrlAllowed } from "./networkPolicy";
import { backendLabel, isEmbeddingModel } from "./openaiModelDiscovery";
import type { OpenAiProviderOptions } from "./openaiAdapter";
import { SseParser, SseEvent } from "./sseParser";
import {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  ModelInfo,
  NetworkPolicy,
  OpenAiEndpointInspection,
  ProviderCapabilities,
  ProviderProfile,
  TokenUsage,
  ToolCall
} from "./types";

// Anthropic Messages API version pin. Stable since 2023-06-01; required on every request alongside
// x-api-key. A user can override it (or add anthropic-beta) via the profile's extraHeaders.
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicToolBlockState {
  id: string;
  name: string;
  argumentsJson: string;
}

interface AnthropicStreamState {
  readonly toolBlocks: Map<number, AnthropicToolBlockState>;
  promptTokens?: number;
  completionTokens?: number;
  done: boolean;
}

// Native Anthropic Messages API provider. Implements the same LlmProvider contract as the
// OpenAI-compatible provider and emits the identical LlmStreamEvent sequence the agent loop consumes,
// so nothing downstream changes. Raw fetch + SseParser only — no SDK dependency (keeps the extension
// offline-first / zero-runtime-dependency).
export class AnthropicMessagesProvider implements LlmProvider {
  readonly profile: ProviderProfile;
  private readonly policy: NetworkPolicy;
  private readonly options: OpenAiProviderOptions;

  constructor(profile: ProviderProfile, policy: NetworkPolicy, options: OpenAiProviderOptions = {}) {
    this.profile = profile;
    this.policy = policy;
    this.options = options;
  }

  async *streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const url = this.endpoint("messages");
    assertUrlAllowed(url, this.policy);

    const maxRateLimitRetries = resolveMaxRateLimitRetries(this.options.maxRateLimitRetries);
    let rateLimitRetries = 0;
    let response: Response;
    for (;;) {
      response = await this.fetchMessageStream(url, request);
      if (response.ok) {
        break;
      }
      // 429 (rate limit) and 5xx are transient — honor Retry-After, back off, and retry instead of
      // failing the whole turn. Mirrors the OpenAI provider's rate-limit handling.
      if (isRetryableHttpStatus(response.status) && rateLimitRetries < maxRateLimitRetries && !request.signal?.aborted) {
        rateLimitRetries++;
        const waitMs = rateLimitDelayMs(response.headers, rateLimitRetries);
        yield { type: "rateLimit", waitMs, attempt: rateLimitRetries };
        await abortableDelay(waitMs, request.signal);
        continue;
      }
      throw new Error(anthropicErrorMessage(response.status, await safeResponseText(response), rateLimitRetries));
    }
    if (!response.body) {
      throw new Error("Anthropic endpoint did not return a stream body.");
    }

    const decoder = new TextDecoder();
    const parser = new SseParser();
    const reader = response.body.getReader();
    const streamCompletionGraceMs = resolveStreamCompletionGraceMs(this.options.streamCompletionGraceMs);
    const state: AnthropicStreamState = { toolBlocks: new Map(), done: false };
    let sawStreamEvent = false;
    let quietExtensionsRemaining = resolveStreamQuietExtensions(this.options.streamQuietExtensions);
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

    try {
      streamLoop:
      while (!state.done) {
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
          // The stream went quiet mid-message. If a tool_use block's JSON is still incomplete, give it
          // a few more grace windows before giving up; otherwise treat the quiet as end-of-turn.
          if (quietExtensionsRemaining > 0 && hasIncompleteToolArgs(state.toolBlocks)) {
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
          sawStreamEvent = true;
          yield* this.parseAnthropicEvent(event, state);
          if (state.done) {
            break streamLoop;
          }
        }
      }

      if (!state.done) {
        for (const event of parser.flush()) {
          yield* this.parseAnthropicEvent(event, state);
          if (state.done) {
            break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const usage = mergeUsage(state.promptTokens, state.completionTokens);
    if (usage) {
      yield { type: "usage", usage };
    }
    const finalToolCalls = [...state.toolBlocks.values()]
      .filter((block) => block.name)
      .map((block): ToolCall => ({ id: block.id, name: block.name, argumentsJson: block.argumentsJson }));
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
    let discovered: readonly ModelInfo[] = [];
    try {
      const response = await fetchWithRateLimitRetry(
        () => fetch(url, { headers: this.headers(), signal }),
        resolveMaxRateLimitRetries(this.options.maxRateLimitRetries),
        signal
      );
      if (response.ok) {
        // Drop embedding models — they can't serve chat turns and shouldn't appear in the picker.
        discovered = parseAnthropicModels(await response.json()).filter((model) => !isEmbeddingModel(model));
      }
    } catch {
      // Network failure / endpoint without a /v1/models listing — fall back to the known catalogue so
      // the model picker still works. A bad API key surfaces on the first actual /v1/messages request.
    }
    return {
      backend: "anthropic",
      backendLabel: backendLabel("anthropic"),
      models: withAnthropicFallback(discovered)
    };
  }

  // Anthropic always streams, lists models, and supports native tool calls — no HTTP probe is needed
  // (and the OpenAI tool probe would POST a tool schema Anthropic rejects).
  async probeCapabilities(): Promise<ProviderCapabilities> {
    return { streaming: true, modelListing: true, nativeToolCalls: true };
  }

  private *parseAnthropicEvent(event: SseEvent, state: AnthropicStreamState): Iterable<LlmStreamEvent> {
    const name = event.event;
    if (name === "error") {
      throw new Error(`Anthropic stream error: ${event.data}`);
    }
    if (name === "ping") {
      // Keep the idle watchdog alive during long thinking/tool-arg generation.
      yield { type: "progress" };
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      // A partial or non-JSON frame (e.g. flushed after a quiet-cancelled stream) must not throw out of
      // the turn; accumulated content/tool deltas are preserved on `state`.
      return;
    }
    if (!isRecord(payload)) {
      return;
    }

    switch (name) {
      case "message_start": {
        const usage = isRecord(payload.message) ? payload.message.usage : undefined;
        const input = isRecord(usage) ? usage.input_tokens : undefined;
        if (typeof input === "number") {
          state.promptTokens = input;
        }
        return;
      }
      case "content_block_start": {
        const block = payload.content_block;
        const index = typeof payload.index === "number" ? payload.index : 0;
        if (isRecord(block) && block.type === "tool_use") {
          state.toolBlocks.set(index, {
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            argumentsJson: ""
          });
        }
        return;
      }
      case "content_block_delta": {
        const delta = payload.delta;
        const index = typeof payload.index === "number" ? payload.index : 0;
        if (!isRecord(delta)) {
          return;
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "content", text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          yield { type: "reasoning", text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = state.toolBlocks.get(index);
          if (block) {
            block.argumentsJson += delta.partial_json;
          }
          yield { type: "progress" };
        }
        return;
      }
      case "message_delta": {
        const usage = payload.usage;
        const output = isRecord(usage) ? usage.output_tokens : undefined;
        if (typeof output === "number") {
          state.completionTokens = output;
        }
        return;
      }
      case "message_stop": {
        state.done = true;
        return;
      }
      default:
        return;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (this.profile.apiKey) {
      // The official Anthropic API authenticates with the key in `x-api-key`; Anthropic-compatible
      // gateways (AskSage, and most proxies) use `Authorization: Bearer`. Pick by host so the right
      // scheme is sent — sending both makes the official API reject the request. A profile can still
      // override either via extraHeaders.
      if (this.isOfficialAnthropicHost()) {
        headers["x-api-key"] = this.profile.apiKey;
      } else {
        headers.authorization = `Bearer ${this.profile.apiKey}`;
      }
    }
    return { ...headers, ...(this.profile.extraHeaders ?? {}) };
  }

  private isOfficialAnthropicHost(): boolean {
    try {
      const host = new URL(this.profile.baseUrl.trim()).hostname.toLowerCase();
      return host === "anthropic.com" || host.endsWith(".anthropic.com");
    } catch {
      return false;
    }
  }

  private fetchMessageStream(url: string, request: LlmRequest): Promise<Response> {
    const parts: AnthropicRequestParts = toAnthropicRequest(request.messages, request.tools);
    const modelInfo = ANTHROPIC_MODEL_FALLBACK.find((model) => model.id === request.model);
    const maxTokens = resolveAnthropicMaxTokens(modelInfo, request.maxTokens);
    return fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        max_tokens: maxTokens,
        ...(parts.system ? { system: parts.system } : {}),
        messages: parts.messages,
        ...(parts.tools ? { tools: parts.tools } : {}),
        // Sampling params (temperature/top_p/top_k) are omitted: the current Opus/Fable models reject
        // them, and CodeForge's near-zero temperature is an OpenAI-local-model determinism knob with no
        // analogue here. Thinking is also left off in this phase.
        stream: true
      }),
      signal: request.signal
    });
  }

  private endpoint(path: string): string {
    return `${this.anthropicBaseUrl()}/v1/${path}`;
  }

  // Normalize the configured base URL so endpoint() can append /v1/<path> uniformly. The base path is
  // preserved (e.g. AskSage's https://api.asksage.ai/server/anthropic stays intact and becomes
  // .../server/anthropic/v1/messages); only a trailing /v1 and any #fragment / ?query are removed. So
  // https://api.anthropic.com, https://api.anthropic.com/v1, https://api.asksage.ai/server/anthropic,
  // and http://localhost:1234#anthropic all resolve to the correct origin + path.
  private anthropicBaseUrl(): string {
    const trimmed = this.profile.baseUrl.trim().replace(/\/+$/, "");
    try {
      const url = new URL(trimmed);
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      return url.toString().replace(/\/+$/, "");
    } catch {
      return trimmed.replace(/[#?].*$/, "").replace(/\/v1$/, "");
    }
  }
}

function mergeUsage(promptTokens: number | undefined, completionTokens: number | undefined): TokenUsage | undefined {
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    // Anthropic reports input/output separately with no total — sum what we have.
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0)
  };
}

function hasIncompleteToolArgs(toolBlocks: ReadonlyMap<number, AnthropicToolBlockState>): boolean {
  for (const block of toolBlocks.values()) {
    if (!block.name) {
      continue;
    }
    const args = block.argumentsJson.trim();
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

function anthropicErrorMessage(status: number, body: string, retries: number): string {
  if (status === 429) {
    const attempts = retries > 0 ? ` after ${retries} retr${retries === 1 ? "y" : "ies"}` : "";
    return `Anthropic endpoint is rate-limited (HTTP 429)${attempts}. Wait for the limit to reset or slow the request rate. Endpoint response: ${body}`;
  }
  if (status === 401) {
    return `Anthropic request failed (HTTP 401): the API key is missing or invalid. Set the endpoint's API key (sent as x-api-key). Endpoint response: ${body}`;
  }
  return `Anthropic endpoint returned HTTP ${status}: ${body}`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function resolveStreamCompletionGraceMs(optionMs: number | undefined): number {
  if (typeof optionMs === "number" && Number.isFinite(optionMs) && optionMs > 0) {
    return Math.min(Math.max(optionMs, 10), 120_000);
  }
  return 30_000;
}

function resolveStreamQuietExtensions(optionCount: number | undefined): number {
  if (typeof optionCount === "number" && Number.isFinite(optionCount) && optionCount >= 0) {
    return Math.min(Math.max(Math.floor(optionCount), 0), 5);
  }
  return 1;
}
