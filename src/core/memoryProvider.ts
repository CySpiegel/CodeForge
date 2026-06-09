// Pluggable memory provider interface — TS port of Hermes `agent/memory_provider.py`.
//
// Memory providers give the agent persistent recall across sessions. The MemoryManager
// enforces a one-external-provider limit (builtin is always present) to prevent tool-schema
// bloat and conflicting backends. External providers (e.g. the holographic durable store)
// register via the provider registry and are activated by the `memory.provider` setting.
//
// Unlike Hermes — which uses background threads — every method here is async and the manager
// serializes writes through a single promise queue, so providers never need their own locking.

import { ChatMessage, ToolDefinition } from "./types";

/** The two curated-notes stores the agent edits. */
export type MemoryTarget = "memory" | "user";

/** Context handed to a provider when a session starts (or switches). */
export interface MemoryInitContext {
  readonly sessionId: string;
  /** Stable identifier for the current workspace, when one is open. */
  readonly workspaceId?: string;
  /** True for a genuinely new conversation (reset/new), false for a resume/continuation. */
  readonly reset?: boolean;
}

export interface MemoryProvider {
  /** Short identifier, e.g. "builtin" or "holographic". */
  readonly name: string;

  // -- Core lifecycle (implement these) ------------------------------------

  /** True if configured, has credentials, and is ready. No network calls. */
  isAvailable(): boolean;

  /** Initialize for a session. Called once at session start; may warm caches, open stores. */
  initialize(ctx: MemoryInitContext): Promise<void>;

  /** Tool schemas this provider exposes to the model. Empty if context-only. */
  getToolSchemas(): readonly ToolDefinition[];

  // -- Optional surface (override to opt in) -------------------------------

  /** Static text for the system prompt (e.g. the frozen curated-notes snapshot). */
  systemPromptBlock?(): string;

  /**
   * Recall relevant context for the upcoming turn. Returns formatted text to inject into
   * the user message (wrapped in <memory-context> fences by the manager), or "".
   * Should be fast — do heavy recall in queuePrefetch and return cached results here.
   */
  prefetch?(query: string): Promise<string>;

  /** Queue a background recall whose result the next prefetch() consumes. */
  queuePrefetch?(query: string): void;

  /** Persist a completed turn to the backend. Should be non-blocking. */
  syncTurn?(userContent: string, assistantContent: string, messages?: readonly ChatMessage[]): Promise<void>;

  /** Handle a tool call for one of this provider's tools. Returns a JSON string result. */
  handleToolCall?(toolName: string, args: Record<string, unknown>): Promise<string>;

  /** Clean shutdown — flush queues, close connections. */
  shutdown?(): Promise<void>;

  // -- Hooks ----------------------------------------------------------------

  /** Per-turn tick with the user message (turn counting, periodic maintenance). */
  onTurnStart?(turnNumber: number, message: string): void;

  /** Session boundary (explicit exit/timeout). Use for end-of-session extraction. */
  onSessionEnd?(messages: readonly ChatMessage[]): Promise<void>;

  /** Mid-process session_id rotation (reset/new/compaction continuation). */
  onSessionSwitch?(newSessionId: string, options: { readonly reset?: boolean }): Promise<void>;

  /** Called before context compaction discards messages; return text to fold into the summary. */
  onPreCompress?(messages: readonly ChatMessage[]): string;

  /** Mirror a builtin memory write to an external backend. */
  onMemoryWrite?(action: "add" | "replace" | "remove", target: MemoryTarget, content: string): void;
}
