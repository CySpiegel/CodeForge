import { ContextItem, ContextLimits, WorkspacePort } from "./types";
import { formatMemories, MemoryEntry } from "./memory";
import { buildWorkspaceIndex } from "./workspaceIndex";

export interface ContextBuilderSources {
  readonly memories?: readonly MemoryEntry[];
  readonly mcpResources?: readonly ContextItem[];
  readonly pinnedFiles?: readonly string[];
}

export class ContextBuilder {
  private readonly workspace: WorkspacePort;
  private readonly limits: ContextLimits;
  private readonly sources: ContextBuilderSources;

  constructor(workspace: WorkspacePort, limits: ContextLimits, sources: ContextBuilderSources = {}) {
    this.workspace = workspace;
    this.limits = limits;
    this.sources = sources;
  }

  async build(signal?: AbortSignal): Promise<readonly ContextItem[]> {
    const items: ContextItem[] = [];
    let budget = this.limits.maxBytes;

    for (const item of await this.loadProjectInstructions(Math.min(32000, Math.max(0, budget)), signal)) {
      const trimmed = trimToBudget(item.content, budget);
      if (trimmed) {
        items.push({ ...item, content: trimmed });
        budget -= byteLength(trimmed);
      }
    }

    const memoryItem = this.memoryContextItem(Math.min(16000, Math.max(0, budget)));
    if (memoryItem && budget > 0) {
      items.push(memoryItem);
      budget -= byteLength(memoryItem.content);
    }

    for (const item of this.sources.mcpResources ?? []) {
      if (items.length >= this.limits.maxFiles || budget <= 0) {
        break;
      }
      const trimmed = trimToBudget(item.content, Math.min(32000, budget));
      if (trimmed) {
        items.push({ ...item, content: trimmed });
        budget -= byteLength(trimmed);
      }
    }

    for (const path of this.sources.pinnedFiles ?? []) {
      if (items.length >= this.limits.maxFiles || budget <= 0) {
        break;
      }
      try {
        const content = await this.workspace.readTextFile(path, Math.min(32000, budget), signal);
        const trimmed = trimToBudget(content, budget);
        if (trimmed) {
          items.push({ kind: "file", label: `Pinned: ${path}`, content: trimmed });
          budget -= byteLength(trimmed);
        }
      } catch {
        // Pinned files can disappear or be renamed; keep context collection resilient.
      }
    }

    if (budget > 0 && items.length < this.limits.maxFiles) {
      const index = await buildWorkspaceIndex(this.workspace, {
        maxFiles: Math.min(500, Math.max(this.limits.maxFiles * 10, 80)),
        maxAnalyzedFiles: Math.min(48, Math.max(this.limits.maxFiles * 2, 12)),
        maxBytesPerFile: 12000
      }, signal);
      if (index) {
        const trimmed = trimToBudget(index.content, Math.min(32000, budget));
        if (trimmed) {
          items.push({ ...index, content: trimmed });
          budget -= byteLength(trimmed);
        }
      }
    }

    if (budget > 0 && items.length < this.limits.maxFiles) {
      const files = await this.workspace.listTextFiles(this.limits.maxFiles, signal);
      const tree = files.join("\n");
      const trimmedTree = trimToBudget(tree, Math.min(12000, budget));
      if (trimmedTree) {
        items.push({
          kind: "fileTree",
          label: "Repo file list",
          content: trimmedTree
        });
      }
    }

    return items;
  }

  format(items: readonly ContextItem[]): string {
    if (items.length === 0) {
      return "No repo context is currently attached.";
    }

    return items.map(formatContextItem).join("\n\n");
  }

  private async loadProjectInstructions(maxBytes: number, signal?: AbortSignal): Promise<readonly ContextItem[]> {
    if (maxBytes <= 0) {
      return [];
    }

    const instructionFiles = ["CODEFORGE.md", "CLAUDE.md"];
    const items: ContextItem[] = [];
    let remaining = maxBytes;
    for (const path of instructionFiles) {
      if (remaining <= 0) {
        break;
      }
      try {
        const content = await this.workspace.readTextFile(path, remaining, signal);
        const trimmed = trimToBudget(content.trim(), remaining);
        if (trimmed) {
          items.push({ kind: "projectInstructions", label: path, content: trimmed });
          remaining -= byteLength(trimmed);
        }
      } catch {
        // Project instruction files are optional.
      }
    }
    return items;
  }

  private memoryContextItem(maxBytes: number): ContextItem | undefined {
    if (!this.sources.memories || this.sources.memories.length === 0 || maxBytes <= 0) {
      return undefined;
    }

    const content = trimToBudget(formatMemories(this.sources.memories), maxBytes);
    return content
      ? { kind: "memory", label: "CodeForge local memories", content }
      : undefined;
  }
}

export function formatContextItem(item: ContextItem): string {
  return `### ${item.kind}: ${item.label}\n\n${item.content}`;
}

function trimToBudget(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  const suffix = "\n\n[CodeForge clipped this context item to fit the local context budget.]";
  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= maxBytes) {
    return Buffer.from(suffix).subarray(0, maxBytes).toString("utf8");
  }
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  const clipped = Buffer.from(value).subarray(0, contentBudget).toString("utf8");
  return `${clipped}${suffix}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
