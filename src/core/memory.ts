export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly scope?: MemoryScope;
  readonly namespace?: string;
}

export type MemoryScope = "workspace" | "user" | "agent";

export interface MemoryWriteOptions {
  readonly scope?: MemoryScope;
  readonly namespace?: string;
}

export interface MemoryListFilter {
  readonly scope?: MemoryScope;
  readonly namespace?: string;
  readonly includeShared?: boolean;
}

export interface MemoryStore {
  add(text: string, options?: MemoryWriteOptions): Promise<MemoryEntry>;
  update(id: string, text: string, options?: MemoryWriteOptions): Promise<MemoryEntry | undefined>;
  list(filter?: MemoryListFilter): Promise<readonly MemoryEntry[]>;
  remove(id: string): Promise<boolean>;
  clear(filter?: MemoryListFilter): Promise<void>;
}

export function createMemoryId(now = Date.now()): string {
  return `memory-${now}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+\n/g, "\n").slice(0, 12000);
}

export function normalizeMemoryScope(scope: MemoryScope | undefined): MemoryScope {
  return scope ?? "workspace";
}

export function normalizeMemoryNamespace(namespace: string | undefined): string | undefined {
  const normalized = namespace?.trim().toLowerCase();
  return normalized && /^[a-z0-9_-]{1,64}$/.test(normalized) ? normalized : undefined;
}

export function memoryMatchesFilter(memory: MemoryEntry, filter: MemoryListFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  const scope = normalizeMemoryScope(memory.scope);
  const namespace = normalizeMemoryNamespace(memory.namespace);
  if (filter.scope === "agent" && filter.namespace) {
    const filterNamespace = normalizeMemoryNamespace(filter.namespace);
    return (scope === "agent" && namespace === filterNamespace) || (filter.includeShared === true && scope !== "agent");
  }
  if (filter.scope) {
    return scope === filter.scope;
  }
  if (filter.includeShared) {
    return scope !== "agent";
  }
  return true;
}

export function formatMemories(memories: readonly MemoryEntry[]): string {
  return memories
    .map((memory) => `- ${memoryLabel(memory)}${memory.text}`)
    .join("\n");
}

function memoryLabel(memory: MemoryEntry): string {
  const scope = normalizeMemoryScope(memory.scope);
  if (scope === "agent" && memory.namespace) {
    return `[agent:${memory.namespace}] `;
  }
  if (scope === "user") {
    return "[user] ";
  }
  return "";
}
