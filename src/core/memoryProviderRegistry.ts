// Static registry of bundled external memory providers, selected by the `memory.provider` setting.
//
// A VS Code extension can't dynamically import arbitrary user code (Hermes loads plugins from disk),
// so the equivalent here is a closed, bundled registry. The MemoryManager still enforces the
// one-external-provider rule. New backends (e.g. cloud providers) become new entries here.

import { MemoryProvider } from "./memoryProvider";
import { BinaryStore } from "./holographic/sqlite";
import { HolographicMemoryProvider } from "./holographic/holographicProvider";

export const EXTERNAL_MEMORY_PROVIDERS = ["none", "holographic"] as const;
export type ExternalMemoryProviderName = (typeof EXTERNAL_MEMORY_PROVIDERS)[number];

export interface MemoryProviderDeps {
  /** Persistence for the holographic SQLite fact store (raw bytes). */
  readonly holographicPersistence: BinaryStore;
}

export function createExternalMemoryProvider(name: string, deps: MemoryProviderDeps): MemoryProvider | undefined {
  if (name === "holographic") {
    return new HolographicMemoryProvider(deps.holographicPersistence);
  }
  return undefined;
}
