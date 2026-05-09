export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
}

export interface MemoryStore {
  add(text: string): Promise<MemoryEntry>;
  list(): Promise<readonly MemoryEntry[]>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export function createMemoryId(now = Date.now()): string {
  return `memory-${now}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+\n/g, "\n").slice(0, 12000);
}

export function formatMemories(memories: readonly MemoryEntry[]): string {
  return memories
    .map((memory) => `- ${memory.text}`)
    .join("\n");
}
