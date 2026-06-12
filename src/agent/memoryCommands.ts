import { MemoryStore } from "../core/memory";
import type { AgentInspectorEntry, AgentMemorySummary, AgentUiEvent } from "./agentUiTypes";
import { errorMessage } from "./toolText";

export interface MemoryCommandsDeps {
  readonly memoryStore: MemoryStore | undefined;
  recordInspector(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void;
  emit(event: AgentUiEvent): void;
  publishState(): Promise<void>;
}

type MemoryScope = "workspace" | "user" | "agent";

// Owns the user-facing curated-memory commands (the webview's Memory panel: add/update/remove/clear)
// and the read-only summary projection. This is the sole owner of the raw MemoryStore port — distinct
// from the tool-facing MemoryManager (which builds the system-prompt memory block). The controller keeps
// thin public delegates because the view provider and tests call addMemory/updateMemory/... by name.
export class MemoryCommandsService {
  constructor(private readonly deps: MemoryCommandsDeps) {}

  async add(text: string, scope: MemoryScope = "workspace", namespace?: string): Promise<void> {
    if (!this.deps.memoryStore) {
      this.deps.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    try {
      const memory = await this.deps.memoryStore.add(text, { scope, namespace });
      this.deps.recordInspector("info", "memory", `Saved ${scope} memory ${memory.id}.`, memory.text);
      this.deps.emit({ type: "status", text: `Saved local memory ${memory.id}.` });
      await this.deps.publishState();
    } catch (error) {
      this.deps.emit({ type: "error", text: errorMessage(error) });
    }
  }

  async update(id: string, text: string, scope: MemoryScope = "workspace", namespace?: string): Promise<void> {
    if (!this.deps.memoryStore) {
      this.deps.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    try {
      const memory = await this.deps.memoryStore.update(id, text, { scope, namespace });
      if (!memory) {
        this.deps.emit({ type: "error", text: `No local memory found for ${id}.` });
        return;
      }
      this.deps.recordInspector("info", "memory", `Updated ${scope} memory ${memory.id}.`, memory.text);
      this.deps.emit({ type: "status", text: `Updated local memory ${memory.id}.` });
      await this.deps.publishState();
    } catch (error) {
      this.deps.emit({ type: "error", text: errorMessage(error) });
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.deps.memoryStore) {
      this.deps.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    const removed = await this.deps.memoryStore.remove(id);
    this.deps.emit({ type: removed ? "status" : "error", text: removed ? `Removed local memory ${id}.` : `No local memory found for ${id}.` });
    await this.deps.publishState();
  }

  async clear(): Promise<void> {
    if (!this.deps.memoryStore) {
      this.deps.emit({ type: "error", text: "Local memory is not available in this environment." });
      return;
    }
    await this.deps.memoryStore.clear();
    this.deps.emit({ type: "status", text: "Cleared all local CodeForge memories." });
    await this.deps.publishState();
  }

  async summaries(): Promise<readonly AgentMemorySummary[]> {
    if (!this.deps.memoryStore) {
      return [];
    }
    const memories = await this.deps.memoryStore.list().catch(() => []);
    return memories.map((memory) => ({
      id: memory.id,
      text: memory.text,
      createdAt: memory.createdAt,
      scope: memory.scope ?? "workspace",
      namespace: memory.namespace
    }));
  }
}
