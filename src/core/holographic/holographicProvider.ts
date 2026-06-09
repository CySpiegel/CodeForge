// Holographic durable-memory provider (SQLite-backed). Recalls relevant facts into context, mirrors
// curated-memory writes into the fact store, and exposes the fact_store / fact_feedback agent tools
// (save/search/probe/related/reason/contradict + trust feedback) — full parity with Hermes's plugin.

import { ToolDefinition } from "../types";
import { MemoryInitContext, MemoryProvider, MemoryTarget } from "../memoryProvider";
import { BinaryStore } from "./sqlite";
import { HolographicStore } from "./store";
import { FactHit, HolographicRetriever } from "./retrieval";
import { FACT_FEEDBACK_SCHEMA, FACT_STORE_SCHEMA } from "./factTools";

export class HolographicMemoryProvider implements MemoryProvider {
  readonly name = "holographic";
  private readonly store: HolographicStore;
  private readonly retriever: HolographicRetriever;

  constructor(persistence: BinaryStore) {
    this.store = new HolographicStore(persistence);
    this.retriever = new HolographicRetriever(this.store);
  }

  isAvailable(): boolean {
    return true;
  }

  async initialize(_ctx: MemoryInitContext): Promise<void> {
    await this.store.load();
  }

  getToolSchemas(): readonly ToolDefinition[] {
    return [FACT_STORE_SCHEMA, FACT_FEEDBACK_SCHEMA];
  }

  async prefetch(query: string): Promise<string> {
    const hits = this.retriever.search(query, 5);
    if (hits.length === 0) {
      return "";
    }
    void this.store.noteRetrieved(hits.map((hit) => hit.fact.id));
    return `Relevant durable memory recalled for this task:\n${hits.map((hit) => `- ${hit.fact.content}`).join("\n")}`;
  }

  onMemoryWrite(action: "add" | "replace" | "remove", target: MemoryTarget, content: string): void {
    if (action === "add" && content.trim()) {
      void this.store.addFact(content, target).catch(() => undefined);
    }
  }

  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (toolName === "fact_feedback") {
        const id = Number(args.id);
        const ok = Number.isFinite(id) ? await this.store.recordFeedback(id, args.helpful === true) : false;
        return JSON.stringify(ok ? { success: true, id, message: "Trust updated." } : { success: false, error: `No fact ${args.id}.` });
      }
      if (toolName !== "fact_store") {
        return JSON.stringify({ success: false, error: `holographic does not handle tool '${toolName}'.` });
      }
      const action = String(args.action ?? "");
      const limit = clampLimit(args.limit);
      switch (action) {
        case "save": {
          const content = typeof args.content === "string" ? args.content : "";
          if (!content.trim()) {
            return JSON.stringify({ success: false, error: "content is required for save." });
          }
          const fact = await this.store.addFact(content, typeof args.category === "string" ? args.category : "general", parseTags(args.tags));
          return JSON.stringify(fact ? { success: true, id: fact.id, message: "Fact saved." } : { success: false, error: "Empty fact." });
        }
        case "search":
          return hitsResult(this.retriever.search(String(args.query ?? ""), limit));
        case "probe":
          return hitsResult(this.retriever.probe(String(args.entity ?? ""), limit));
        case "related":
          return hitsResult(this.retriever.related(String(args.entity ?? ""), limit));
        case "reason":
          return hitsResult(this.retriever.reason(parseTags(args.entities), limit));
        case "contradict": {
          const pairs = this.retriever.contradict(limit);
          return JSON.stringify({
            success: true,
            contradictions: pairs.map((p) => ({ a: p.a.content, b: p.b.content, score: round(p.score) }))
          });
        }
        case "delete": {
          const id = Number(args.id);
          const ok = Number.isFinite(id) ? await this.store.removeFact(id) : false;
          return JSON.stringify(ok ? { success: true, message: `Deleted fact ${id}.` } : { success: false, error: `No fact ${args.id}.` });
        }
        case "list":
          return JSON.stringify({ success: true, count: this.store.size, facts: this.store.list().slice(0, limit).map((f) => ({ id: f.id, content: f.content, category: f.category, trust: round(f.trust) })) });
        default:
          return JSON.stringify({ success: false, error: `Unknown fact_store action '${action}'.` });
      }
    } catch (error) {
      return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function hitsResult(hits: readonly FactHit[]): string {
  return JSON.stringify({
    success: true,
    count: hits.length,
    facts: hits.map((hit) => ({ id: hit.fact.id, content: hit.fact.content, category: hit.fact.category, trust: round(hit.fact.trust), score: round(hit.score) }))
  });
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 5;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
