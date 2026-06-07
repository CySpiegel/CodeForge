import { assertUrlAllowed } from "./networkPolicy";
import { SseParser } from "./sseParser";
import {
  ChatMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  ModelInfo,
  NetworkPolicy,
  OpenAiBackendKind,
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

    let response = await this.fetchChatStream(url, request, true);
    if (!response.ok && response.status >= 400 && response.status < 500) {
      response = await this.fetchChatStream(url, request, false);
    }

    if (!response.ok) {
      throw new Error(`Endpoint returned HTTP ${response.status}: ${await safeResponseText(response)}`);
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

    const response = await fetch(url, {
      headers: this.headers(false),
      signal
    });

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

    let response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
      signal
    });

    if (!response.ok && response.status >= 400 && response.status < 500) {
      const retryRequest: Record<string, unknown> = { ...request };
      delete retryRequest.tool_choice;
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(retryRequest),
        signal
      });
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
        yield { type: "progress" };
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

// Plausibility bounds for an auto-detected context window. The floor rejects stray small integers
// (a permission `max_tokens: 1`, `n_parallel`, batch sizes) that share a key name; the ceiling
// rejects the HuggingFace ~1e30 "unbounded" sentinel that `model_max_length` can carry.
const MIN_CONTEXT_LENGTH = 256;
const MAX_CONTEXT_LENGTH = 100_000_000;

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

function modelsFromBody(body: unknown): readonly ModelInfo[] {
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
        type: typeof model.type === "string" ? model.type : undefined,
        aliases: toStringArray(model.aliases),
        // Field names are tried in PRIORITY order (not document order): the runtime/loaded window
        // first — the size the server will actually accept — then the model's trained maximum, and
        // finally LiteLLM's input/context fields. findPositiveInteger searches the whole model
        // object (including nested objects like `meta`/`model_info`/`parameters`) for each key in
        // turn, so a higher-priority field anywhere wins over a lower-priority one. The bounds reject
        // implausible values (stray small ints like a permission `max_tokens: 1`, or the HF ~1e30
        // "unbounded" sentinel) so they can't be mistaken for a context window.
        contextLength: findPositiveInteger(model, [
          // Runtime / loaded window — what the server enforces right now.
          "loaded_context_length", // LM Studio: actual allocated window of the loaded model
          "loadedContextLength",
          "max_model_len",         // vLLM / SGLang / DeepInfra: enforced runtime window
          "maxModelLen",
          "n_ctx",                 // llama.cpp: runtime per-slot context (meta.n_ctx)
          "num_ctx",               // Ollama-style runtime context
          // Model-max window — the model's trained/architectural maximum.
          "max_context_length",    // LM Studio (max) / Mistral hosted
          "maxContextLength",
          "context_length",        // OpenRouter / Together AI
          "contextLength",
          "context_window",        // Groq
          "contextWindow",
          "n_ctx_train",           // llama.cpp: trained max (meta.n_ctx_train). On older llama-server
                                   // builds this is the ONLY context signal; ranked below runtime
                                   // n_ctx so the smaller live window wins when both are present.
          "max_sequence_length",
          "maxSequenceLength",
          "max_seq_len",           // TabbyAPI / ExLlamaV2 (parameters.max_seq_len)
          "maxSeqLen",
          "ctx_size",
          "max_position_embeddings", // HF architecture max
          "n_positions",           // older HF architectures (GPT-2 family)
          "model_max_length",      // HF tokenizer/transformers config (may carry an ~1e30 sentinel)
          // LiteLLM reports each served model's own context length. `max_input_tokens` is the
          // precise input-window field; `max_tokens` is LiteLLM's configured context length for
          // that model. Kept lowest because on most other backends `max_tokens` is an OUTPUT cap, so
          // any more specific field above must win first.
          "max_input_tokens",
          "maxInputTokens",
          "max_tokens",
          "maxTokens"
        ], { minValue: MIN_CONTEXT_LENGTH, maxValue: MAX_CONTEXT_LENGTH }),
        // Note: `max_tokens` is intentionally NOT treated as an output limit — on LiteLLM it is the
        // context length (above). Only genuine output fields populate maxOutputTokens here.
        maxOutputTokens: findPositiveInteger(model, [
          "max_output_tokens",
          "maxOutputTokens",
          "max_completion_tokens",
          "maxCompletionTokens"
        ]),
        supportsReasoning: detectsReasoning(model, model.id)
      };
    })
    .filter((model): model is ModelInfo => Boolean(model));
}

function isEmbeddingModel(model: ModelInfo): boolean {
  const fingerprint = `${model.id}\n${model.type ?? ""}`.toLowerCase();
  return fingerprint.includes("embedding") || fingerprint.includes("embed");
}

function detectBackend(headers: Headers, body: unknown, models: readonly ModelInfo[]): OpenAiBackendKind {
  const headersText = headersToText(headers).toLowerCase();
  const bodyText = safeJson(body).toLowerCase();
  const modelText = models.map((model) => model.id).join("\n").toLowerCase();
  const fingerprint = `${headersText}\n${bodyText}\n${modelText}`;

  if (fingerprint.includes("litellm")) {
    return "litellm";
  }
  if (fingerprint.includes("\"owned_by\":\"vllm\"") || fingerprint.includes("\"owned_by\": \"vllm\"") || fingerprint.includes("vllm")) {
    return "vllm";
  }
  return "openai-api";
}

function backendLabel(backend: OpenAiBackendKind): string {
  switch (backend) {
    case "litellm":
      return "LiteLLM";
    case "vllm":
      return "vLLM";
    case "openai-api":
      return "OpenAI API compatible";
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function headersToText(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, key) => {
    lines.push(`${key}: ${value}`);
  });
  return lines.join("\n");
}

function hasFinishReason(data: string): boolean {
  try {
    const chunk = JSON.parse(data) as OpenAiStreamChunk;
    return (chunk.choices ?? []).some((choice) => choice.finish_reason !== undefined && choice.finish_reason !== null);
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

interface IntegerSearchBounds {
  readonly minValue?: number;
  readonly maxValue?: number;
}

// Find the first key (in priority order) that carries a positive integer within `bounds`, searching
// the whole object tree. PRIORITY DOMINATES NESTING DEPTH: each key is searched across every nested
// object before the next key is tried, so a higher-priority field nested under e.g. `meta` or
// `model_info` still beats a lower-priority field sitting at the top level. Arrays are never
// descended into, so a stray integer inside a `permission`/limits list can't be picked up.
function findPositiveInteger(value: unknown, keys: readonly string[], bounds: IntegerSearchBounds = {}): number | undefined {
  for (const key of keys) {
    const found = deepFindInteger(value, key, bounds, 0);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function deepFindInteger(value: unknown, key: string, bounds: IntegerSearchBounds, depth: number): number | undefined {
  if (depth > 4 || !isPlainObject(value)) {
    return undefined;
  }

  const direct = toBoundedInteger(value[key], bounds);
  if (direct !== undefined) {
    return direct;
  }

  for (const nested of Object.values(value)) {
    const found = deepFindInteger(nested, key, bounds, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function detectsReasoning(model: Record<string, unknown>, id: string): boolean | undefined {
  const explicit = findBoolean(model, [
    "supports_reasoning",
    "supportsReasoning",
    "supports_thinking",
    "supportsThinking",
    "reasoning",
    "thinking",
    "is_reasoning_model",
    "isReasoningModel"
  ]);
  if (explicit !== undefined) {
    return explicit;
  }

  const fingerprint = `${id}\n${safeJson(model)}`.toLowerCase();
  if (/\b(reasoning|thinking)\b/.test(fingerprint)) {
    return true;
  }
  if (/(^|[-_./:])(r1|o1|o3|o4|qwq)([-_./:]|$)/.test(id.toLowerCase())) {
    return true;
  }
  return undefined;
}

function findBoolean(value: unknown, keys: readonly string[], depth = 0): boolean | undefined {
  if (depth > 4 || !isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const parsed = toBoolean(value[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  for (const nested of Object.values(value)) {
    const parsed = findBoolean(nested, keys, depth + 1);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function toBoundedInteger(value: unknown, bounds: IntegerSearchBounds): number | undefined {
  const parsed = toPositiveInteger(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (bounds.minValue !== undefined && parsed < bounds.minValue) {
    return undefined;
  }
  if (bounds.maxValue !== undefined && parsed > bounds.maxValue) {
    return undefined;
  }
  return parsed;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Like isRecord but excludes arrays, so deep integer search descends only into plain objects.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
