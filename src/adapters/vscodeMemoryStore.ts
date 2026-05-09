import * as vscode from "vscode";
import { createMemoryId, MemoryEntry, MemoryStore, normalizeMemoryText } from "../core/memory";

const memoryFileName = "memories.json";

export class VsCodeMemoryStore implements MemoryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async add(text: string): Promise<MemoryEntry> {
    const normalized = normalizeMemoryText(text);
    if (!normalized) {
      throw new Error("Memory text must not be empty.");
    }
    const memory: MemoryEntry = {
      id: createMemoryId(),
      text: normalized,
      createdAt: Date.now()
    };
    await this.update((memories) => [...memories, memory]);
    return memory;
  }

  async list(): Promise<readonly MemoryEntry[]> {
    await this.flushPendingWrites();
    return this.readAll();
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.update((memories) => {
      const next = memories.filter((memory) => memory.id !== id);
      removed = next.length !== memories.length;
      return next;
    });
    return removed;
  }

  async clear(): Promise<void> {
    await this.update(() => []);
  }

  private update(change: (memories: readonly MemoryEntry[]) => readonly MemoryEntry[]): Promise<void> {
    this.writeQueue = this.writeQueue.then(
      () => this.updateNow(change),
      () => this.updateNow(change)
    );
    return this.writeQueue;
  }

  private async updateNow(change: (memories: readonly MemoryEntry[]) => readonly MemoryEntry[]): Promise<void> {
    const next = change(await this.readAll());
    await vscode.workspace.fs.createDirectory(this.storageRoot());
    await vscode.workspace.fs.writeFile(this.storageUri(), Buffer.from(JSON.stringify(next, null, 2), "utf8"));
  }

  private async readAll(): Promise<readonly MemoryEntry[]> {
    try {
      const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.storageUri())).toString("utf8"));
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw.map(toMemoryEntry).filter((entry): entry is MemoryEntry => Boolean(entry));
    } catch {
      return [];
    }
  }

  private async flushPendingWrites(): Promise<void> {
    try {
      await this.writeQueue;
    } catch {
      // The next write retries through the queue rejection path.
    }
  }

  private storageUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageRoot(), memoryFileName);
  }

  private storageRoot(): vscode.Uri {
    return this.context.storageUri ?? this.context.globalStorageUri;
  }
}

function toMemoryEntry(value: unknown): MemoryEntry | undefined {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.text !== "string" || typeof value.createdAt !== "number") {
    return undefined;
  }
  return {
    id: value.id,
    text: normalizeMemoryText(value.text),
    createdAt: value.createdAt
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
