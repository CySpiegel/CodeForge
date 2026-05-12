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

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly profile: ProviderProfile;
  private readonly policy: NetworkPolicy;

  constructor(profile: ProviderProfile, policy: NetworkPolicy) {
    this.profile = profile;
    this.policy = policy;
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
    const streamCompletionGraceMs = openAiStreamCompletionGraceMs();
    let sawStreamEvent = false;

    let streamDone = false;
    try {
      streamLoop:
      while (true) {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const readPromise = reader.read();
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
          await reader.cancel().catch(() => undefined);
          break;
        }
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
        arguments: toolCall.argumentsJson
      }
    }));
  }

  return result;
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
        contextLength: findPositiveInteger(model, [
          "context_length",
          "contextLength",
          "max_context_length",
          "maxContextLength",
          "max_model_len",
          "maxModelLen",
          "max_sequence_length",
          "maxSequenceLength",
          "max_seq_len",
          "maxSeqLen",
          "context_window",
          "contextWindow",
          "n_ctx",
          "num_ctx",
          "ctx_size",
          "max_position_embeddings"
        ]),
        maxOutputTokens: findPositiveInteger(model, [
          "max_output_tokens",
          "maxOutputTokens",
          "max_completion_tokens",
          "maxCompletionTokens",
          "max_tokens",
          "maxTokens"
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

function openAiStreamCompletionGraceMs(): number {
  const configured = Number(process.env.CODEFORGE_OPENAI_STREAM_COMPLETION_GRACE_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(configured, 10), 120_000);
  }
  return 15_000;
}

function findPositiveInteger(value: unknown, keys: readonly string[], depth = 0): number | undefined {
  if (depth > 4 || !isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const parsed = toPositiveInteger(value[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  for (const nested of Object.values(value)) {
    const parsed = findPositiveInteger(nested, keys, depth + 1);
    if (parsed !== undefined) {
      return parsed;
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
