// Bridges the curated-notes persistence port onto the existing VS Code MemoryStore.
//
// The builtin provider thinks in two targets (memory/user); the store thinks in scopes. We map
// memory→"workspace" (per-repo, workspace storage) and user→"user" (cross-repo, global storage),
// reusing the store's serialized writeQueue and split global/workspace persistence. Each save
// reconciles the scope to the provider's current entry list.

import { MemoryScope, MemoryStore } from "./memory";
import { MemoryTarget } from "./memoryProvider";
import { CuratedNoteStore } from "./builtinMemoryProvider";

function scopeFor(target: MemoryTarget): MemoryScope {
  return target === "user" ? "user" : "workspace";
}

export function memoryStoreNoteStore(store: MemoryStore): CuratedNoteStore {
  return {
    async load(target: MemoryTarget): Promise<readonly string[]> {
      const entries = await store.list({ scope: scopeFor(target) });
      return entries.map((entry) => entry.text);
    },
    async save(target: MemoryTarget, entries: readonly string[]): Promise<void> {
      const scope = scopeFor(target);
      await store.clear({ scope });
      for (const text of entries) {
        await store.add(text, { scope });
      }
    }
  };
}
