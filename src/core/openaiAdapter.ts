import { assertUrlAllowed } from "./networkPolicy";
import { SseParser } from "./sseParser";
import {
  ChatMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  NetworkPolicy,
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

    for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const events = parser.push(decoder.decode(rawChunk, { stream: true }));
      for (const event of events) {
        yield* this.parseStreamEvent(event.data, toolCalls);
      }
    }

    for (const event of parser.flush()) {
      yield* this.parseStreamEvent(event.data, toolCalls);
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
    const url = this.endpoint("models");
    assertUrlAllowed(url, this.policy);

    const response = await fetch(url, {
      headers: this.headers(false),
      signal
    });

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as { readonly data?: ReadonlyArray<{ readonly id?: string }> };
    return body.data?.map((model) => model.id).filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
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
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: "Call the echo_probe tool with value ok. Return no prose." }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "echo_probe",
              description: "Probe whether the endpoint supports OpenAI tool calls.",
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
        tool_choice: "auto",
        max_tokens: 64,
        temperature: 0
      }),
      signal
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as {
      readonly choices?: ReadonlyArray<{
        readonly message?: {
          readonly tool_calls?: readonly unknown[];
        };
        readonly finish_reason?: string;
      }>;
    };
    const first = body.choices?.[0];
    return first?.finish_reason === "tool_calls" || Boolean(first?.message?.tool_calls?.length);
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

      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const current = toolCalls.get(index) ?? { id: "", name: "", argumentsJson: "" };
        current.id = delta.id ?? current.id;
        current.name = delta.function?.name ?? current.name;
        current.argumentsJson += delta.function?.arguments ?? "";
        toolCalls.set(index, current);
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
    return `${this.profile.baseUrl.replace(/\/+$/, "")}/${path}`;
  }

  private fetchChatStream(url: string, request: LlmRequest, includeUsage: boolean): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAiMessage),
        temperature: request.temperature ?? 0.2,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toOpenAiTool) } : {})
      }),
      signal: request.signal
    });
  }
}

function toOpenAiMessage(message: ChatMessage): Record<string, string> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? message.name ?? "tool"
    };
  }

  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {})
  };
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
