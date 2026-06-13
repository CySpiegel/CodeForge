// MemoryManager — TS port of Hermes `agent/memory_manager.py`.
//
// Single integration point for memory in the agent loop. Holds the always-present builtin
// provider plus at most one external provider (a second external is rejected). Background work
// (sync, prefetch queueing) runs through a single serialized promise queue so turn N's write
// lands before turn N+1's — the same ordering Hermes gets from its single-worker executor.

import { ChatMessage, ToolDefinition } from "../core/types";
import { MemoryInitContext, MemoryProvider, MemoryTarget } from "../core/memoryProvider";
import { buildMemoryContextBlock } from "../core/memoryContext";

export class MemoryManager {
  private readonly providers: MemoryProvider[] = [];
  private readonly toolToProvider = new Map<string, MemoryProvider>();
  private hasExternal = false;
  private queue: Promise<void> = Promise.resolve();

  /** Names of core tools a provider may not shadow. */
  constructor(private readonly reservedToolNames: ReadonlySet<string> = new Set()) {}

  /** Register a provider. The builtin is always accepted; only one external is allowed. */
  addProvider(provider: MemoryProvider): boolean {
    if (provider.name !== "builtin") {
      if (this.hasExternal) {
        console.warn(`[memory] ignoring second external provider '${provider.name}' — one already registered.`);
        return false;
      }
      this.hasExternal = true;
    }
    for (const schema of provider.getToolSchemas()) {
      // The builtin provider's tools (e.g. `memory`) ARE the core memory tools, registered in the
      // tool registry as well; only external providers may not shadow a core tool name.
      if (provider.name !== "builtin" && this.reservedToolNames.has(schema.name)) {
        console.warn(`[memory] provider '${provider.name}' tool '${schema.name}' shadows a core tool — skipped.`);
        continue;
      }
      if (!this.toolToProvider.has(schema.name)) {
        this.toolToProvider.set(schema.name, provider);
      }
    }
    this.providers.push(provider);
    return true;
  }

  get providerNames(): readonly string[] {
    return this.providers.map((p) => p.name);
  }

  async initializeAll(ctx: MemoryInitContext): Promise<void> {
    for (const provider of this.providers) {
      await this.safe(() => provider.initialize(ctx), `initialize ${provider.name}`);
    }
  }

  /** Concatenate every provider's static system-prompt block (e.g. the frozen curated notes). */
  buildSystemPrompt(): string {
    const blocks: string[] = [];
    for (const provider of this.providers) {
      const block = provider.systemPromptBlock?.();
      if (block) {
        blocks.push(block);
      }
    }
    return blocks.join("\n\n");
  }

  /** Tool schemas from all providers (first registration of a name wins). */
  getAllToolSchemas(): readonly ToolDefinition[] {
    const seen = new Set<string>();
    const out: ToolDefinition[] = [];
    for (const provider of this.providers) {
      for (const schema of provider.getToolSchemas()) {
        if (!seen.has(schema.name) && (provider.name === "builtin" || !this.reservedToolNames.has(schema.name))) {
          seen.add(schema.name);
          out.push(schema);
        }
      }
    }
    return out;
  }

  hasTool(name: string): boolean {
    return this.toolToProvider.has(name);
  }

  /** Route a tool call to its provider. Mirrors a builtin memory write to external providers. */
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    const provider = this.toolToProvider.get(name);
    if (!provider || !provider.handleToolCall) {
      return JSON.stringify({ success: false, error: `No memory provider handles tool '${name}'.` });
    }
    const result = await provider.handleToolCall(name, args);
    if (name === "memory" && provider.name === "builtin") {
      this.mirrorMemoryWrite(args, result);
    }
    return result;
  }

  /** Recall context for the upcoming turn, wrapped in <memory-context> fences. "" if nothing. */
  async prefetchAll(query: string): Promise<string> {
    const parts: string[] = [];
    for (const provider of this.providers) {
      if (!provider.prefetch) {
        continue;
      }
      const text = await this.safeValue(() => provider.prefetch!(query), `prefetch ${provider.name}`, "");
      if (text && text.trim()) {
        parts.push(text.trim());
      }
    }
    if (parts.length === 0) {
      return "";
    }
    return buildMemoryContextBlock(parts.join("\n\n"));
  }

  queuePrefetchAll(query: string): void {
    void this.enqueue(async () => {
      for (const provider of this.providers) {
        await this.safe(async () => provider.queuePrefetch?.(query), `queuePrefetch ${provider.name}`);
      }
    });
  }

  /** Persist a completed turn through the serialized background queue (non-blocking). */
  syncAll(userContent: string, assistantContent: string, messages?: readonly ChatMessage[]): void {
    void this.enqueue(async () => {
      for (const provider of this.providers) {
        if (provider.syncTurn) {
          await this.safe(() => provider.syncTurn!(userContent, assistantContent, messages), `syncTurn ${provider.name}`);
        }
      }
    });
  }

  /** Wait for queued background work to drain (e.g. before a reset/compaction discards messages). */
  async flushPending(timeoutMs = 5000): Promise<void> {
    await Promise.race([
      this.queue.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  // -- Lifecycle fan-out ----------------------------------------------------

  onTurnStart(turnNumber: number, message: string): void {
    for (const provider of this.providers) {
      try {
        provider.onTurnStart?.(turnNumber, message);
      } catch (error) {
        this.logError(`onTurnStart ${provider.name}`, error);
      }
    }
  }

  async onSessionEnd(messages: readonly ChatMessage[]): Promise<void> {
    for (const provider of this.providers) {
      await this.safe(async () => provider.onSessionEnd?.(messages), `onSessionEnd ${provider.name}`);
    }
  }

  async onSessionSwitch(newSessionId: string, options: { readonly reset?: boolean }): Promise<void> {
    for (const provider of this.providers) {
      await this.safe(async () => provider.onSessionSwitch?.(newSessionId, options), `onSessionSwitch ${provider.name}`);
    }
  }

  /** Collect provider contributions to a compaction summary before messages are discarded. */
  onPreCompress(messages: readonly ChatMessage[]): string {
    const parts: string[] = [];
    for (const provider of this.providers) {
      try {
        const text = provider.onPreCompress?.(messages);
        if (text && text.trim()) {
          parts.push(text.trim());
        }
      } catch (error) {
        this.logError(`onPreCompress ${provider.name}`, error);
      }
    }
    return parts.join("\n\n");
  }

  async shutdownAll(): Promise<void> {
    await this.flushPending();
    for (const provider of [...this.providers].reverse()) {
      await this.safe(async () => provider.shutdown?.(), `shutdown ${provider.name}`);
    }
  }

  // -- Internals ------------------------------------------------------------

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  private mirrorMemoryWrite(args: Record<string, unknown>, result: string): void {
    let ok = false;
    try {
      ok = Boolean((JSON.parse(result) as { success?: boolean }).success);
    } catch {
      ok = false;
    }
    const action = args.action;
    const target = args.target;
    if (!ok || (action !== "add" && action !== "replace" && action !== "remove")) {
      return;
    }
    if (target !== "memory" && target !== "user") {
      return;
    }
    const content = typeof args.content === "string" ? args.content : "";
    for (const provider of this.providers) {
      if (provider.name === "builtin" || !provider.onMemoryWrite) {
        continue;
      }
      try {
        provider.onMemoryWrite(action as "add" | "replace" | "remove", target as MemoryTarget, content);
      } catch (error) {
        this.logError(`onMemoryWrite ${provider.name}`, error);
      }
    }
  }

  private async safe(fn: () => Promise<unknown> | unknown, label: string): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logError(label, error);
    }
  }

  private async safeValue<T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logError(label, error);
      return fallback;
    }
  }

  private logError(label: string, error: unknown): void {
    console.warn(`[memory] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
