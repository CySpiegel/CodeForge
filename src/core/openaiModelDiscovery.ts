import { ModelInfo, OpenAiBackendKind } from "./types";

// Endpoint model-discovery parsing: turn a /v1/models response body into ModelInfo[] (with robust,
// priority-ordered context-length + output-limit + reasoning detection across backend-specific field
// names and nesting), classify the backend, and label it. Pure functions — the OpenAiCompatibleProvider
// class owns the HTTP fetch (inspectEndpoint) and calls in here.

// Detected context-window values must fall within these bounds — rejects stray small ints (a permission
// `max_tokens: 1`, batch sizes) and the HuggingFace ~1e30 "unbounded" sentinel.
const MIN_CONTEXT_LENGTH = 256;
const MAX_CONTEXT_LENGTH = 100_000_000;

interface IntegerSearchBounds {
  readonly minValue?: number;
  readonly maxValue?: number;
}

export function modelsFromBody(body: unknown): readonly ModelInfo[] {
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

export function isEmbeddingModel(model: ModelInfo): boolean {
  const fingerprint = `${model.id}\n${model.type ?? ""}`.toLowerCase();
  return fingerprint.includes("embedding") || fingerprint.includes("embed");
}

export function detectBackend(headers: Headers, body: unknown, models: readonly ModelInfo[]): OpenAiBackendKind {
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

export function backendLabel(backend: OpenAiBackendKind): string {
  switch (backend) {
    case "litellm":
      return "LiteLLM";
    case "vllm":
      return "vLLM";
    case "openai-api":
      return "OpenAI API compatible";
  }
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
