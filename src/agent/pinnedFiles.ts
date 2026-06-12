import { WorkspacePort } from "../core/types";
import type { AgentUiEvent } from "./agentUiTypes";
import { errorMessage } from "./toolText";

export interface PinnedFilesDeps {
  readonly workspace: WorkspacePort;
  emit(event: AgentUiEvent): void;
  publishState(): Promise<void>;
}

// Owns the set of files the user has pinned into every request's context. Sole owner of the pinned-set
// mutation; the run engine and getState read it through list(), and the lifecycle paths clear() it.
export class PinnedFiles {
  private files = new Set<string>();

  constructor(private readonly deps: PinnedFilesDeps) {}

  list(): readonly string[] {
    return [...this.files];
  }

  clear(): void {
    this.files.clear();
  }

  async pinActive(): Promise<void> {
    const active = await this.deps.workspace.getActiveTextDocument(1);
    if (!active || active.label.startsWith("Unsaved active")) {
      this.deps.emit({ type: "error", text: "Focus a repo file to pin it, or use /pin <repo-relative path>." });
      return;
    }
    await this.pin(active.label);
  }

  async pin(path: string): Promise<void> {
    const normalized = path.trim().replace(/^Pinned:\s*/, "");
    if (!normalized) {
      this.deps.emit({ type: "error", text: "Provide a repo-relative file path to pin." });
      return;
    }
    try {
      await this.deps.workspace.readTextFile(normalized, 1);
      this.files.add(normalized);
      this.deps.emit({ type: "status", text: `Pinned ${normalized} for future context.` });
      await this.deps.publishState();
    } catch (error) {
      this.deps.emit({ type: "error", text: `Could not pin ${normalized}: ${errorMessage(error)}` });
    }
  }

  async unpin(path?: string): Promise<void> {
    if (!path || path.trim().toLowerCase() === "all") {
      this.files.clear();
      this.deps.emit({ type: "status", text: "Cleared pinned context files." });
      await this.deps.publishState();
      return;
    }
    const normalized = path.trim().replace(/^Pinned:\s*/, "");
    const removed = this.files.delete(normalized);
    this.deps.emit({ type: removed ? "status" : "error", text: removed ? `Unpinned ${normalized}.` : `${normalized} was not pinned.` });
    await this.deps.publishState();
  }
}
