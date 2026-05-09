import { ContextItem, ContextLimits, WorkspacePort } from "./types";

export class ContextBuilder {
  private readonly workspace: WorkspacePort;
  private readonly limits: ContextLimits;

  constructor(workspace: WorkspacePort, limits: ContextLimits) {
    this.workspace = workspace;
    this.limits = limits;
  }

  async build(signal?: AbortSignal): Promise<readonly ContextItem[]> {
    const items: ContextItem[] = [];
    let budget = this.limits.maxBytes;

    const selection = await this.workspace.getActiveSelection(Math.min(16000, budget));
    if (selection && budget > 0) {
      items.push(selection);
      budget -= byteLength(selection.content);
    }

    const openDocuments = await this.workspace.getOpenTextDocuments(Math.min(24000, Math.max(0, budget)));
    for (const item of openDocuments) {
      if (items.length >= this.limits.maxFiles || budget <= 0) {
        break;
      }
      const trimmed = trimToBudget(item.content, budget);
      if (trimmed) {
        items.push({ ...item, content: trimmed });
        budget -= byteLength(trimmed);
      }
    }

    if (budget > 0 && items.length < this.limits.maxFiles) {
      const files = await this.workspace.listTextFiles(this.limits.maxFiles, signal);
      const tree = files.join("\n");
      const trimmedTree = trimToBudget(tree, Math.min(12000, budget));
      if (trimmedTree) {
        items.push({
          kind: "fileTree",
          label: "Workspace file list",
          content: trimmedTree
        });
      }
    }

    return items;
  }

  format(items: readonly ContextItem[]): string {
    if (items.length === 0) {
      return "No workspace context is currently attached.";
    }

    return items.map((item) => {
      return `### ${item.kind}: ${item.label}\n\n${item.content}`;
    }).join("\n\n");
  }
}

function trimToBudget(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  const clipped = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  return `${clipped}\n\n[CodeForge clipped this context item to fit the local context budget.]`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
