import { parseUnifiedDiff, targetPath } from "../core/unifiedDiff";
import { AgentAction } from "../core/types";
import type { AgentInspectorEntry, AgentUiEvent } from "./agentUiTypes";
import { errorMessage } from "./toolText";

// How many prior-change snapshots to keep, and the per-file byte cap above which a file is too large to
// snapshot safely (restoring a truncated copy would corrupt it).
const undoStackLimit = 25;
const undoSnapshotMaxBytes = 5_000_000;

interface UndoSnapshot {
  readonly summary: string;
  readonly createdAt: number;
  readonly files: ReadonlyArray<{ readonly path: string; readonly previousContent: string | null; readonly restorable: boolean }>;
}

export interface UndoManagerDeps {
  // Read a file's current bytes for snapshotting (rejects if the file does not exist yet).
  readFileSnapshot(path: string, maxBytes: number): Promise<string>;
  // Restore a file to prior content, or delete it when previousContent is null (the action created it).
  restoreFile(path: string, previousContent: string | null): Promise<void>;
  forgetReadState(path: string): void;
  emit(event: AgentUiEvent): void;
  recordInspector(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void;
  publishState(): Promise<void>;
  // True while a request is running — undo is refused mid-run.
  isBusy(): boolean;
}

// Owns the bounded stack of pre-change file snapshots captured at each checkpoint, and the /undo restore.
// The controller records checkpoints (capture) before applying an edit/write/patch and delegates the
// user-facing /undo here; this module holds the only copy of the undo stack.
export class UndoManager {
  private undoStack: UndoSnapshot[] = [];

  constructor(private readonly deps: UndoManagerDeps) {}

  reset(): void {
    this.undoStack = [];
  }

  // Snapshot the current content of every file an edit/write/patch is about to change, so /undo can
  // restore it. Called before the change applies. Best-effort and never throws.
  async capture(action: AgentAction, summary: string): Promise<void> {
    const paths = undoTargetPaths(action);
    if (paths.length === 0) {
      return;
    }
    const files = await Promise.all(paths.map(async (path) => {
      try {
        const content = await this.deps.readFileSnapshot(path, undoSnapshotMaxBytes);
        // If we hit the cap the snapshot is truncated; restoring it would corrupt the file, so mark it
        // unrestorable rather than silently losing data.
        const restorable = Buffer.byteLength(content, "utf8") < undoSnapshotMaxBytes;
        return { path, previousContent: content, restorable };
      } catch {
        // The file does not exist yet — the action creates it, so undo deletes it.
        return { path, previousContent: null, restorable: true };
      }
    }));
    this.undoStack.push({ summary, createdAt: Date.now(), files });
    if (this.undoStack.length > undoStackLimit) {
      this.undoStack.shift();
    }
  }

  async undo(): Promise<void> {
    if (this.deps.isBusy()) {
      this.deps.emit({ type: "status", text: "Finish or stop the current request before undoing." });
      return;
    }
    const snapshot = this.undoStack.pop();
    if (!snapshot) {
      this.deps.emit({ type: "message", role: "system", text: "Nothing to undo — no file changes have been applied this session." });
      return;
    }
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const file of snapshot.files) {
      if (!file.restorable) {
        skipped.push(`${file.path} (too large to snapshot)`);
        continue;
      }
      try {
        await this.deps.restoreFile(file.path, file.previousContent);
        this.deps.forgetReadState(file.path);
        restored.push(file.previousContent === null ? `${file.path} (removed new file)` : file.path);
      } catch (error) {
        skipped.push(`${file.path} (${errorMessage(error)})`);
      }
    }
    const parts = [`↩️ Undid: ${snapshot.summary}`];
    if (restored.length > 0) {
      parts.push(`Restored ${restored.join(", ")}.`);
    }
    if (skipped.length > 0) {
      parts.push(`Could not restore ${skipped.join(", ")}.`);
    }
    this.deps.recordInspector("info", "tool", "Undo applied.", parts.join(" "));
    this.deps.emit({ type: "message", role: "system", text: parts.join(" ") });
    void this.deps.publishState();
  }
}

// The repo-relative paths an action is about to modify, used to snapshot them for undo. Only the
// file-mutating actions are covered; commands and reads return none.
function undoTargetPaths(action: AgentAction): readonly string[] {
  if (action.type === "write_file" || action.type === "edit_file") {
    return [action.path];
  }
  if (action.type === "propose_patch") {
    try {
      return parseUnifiedDiff(action.patch).map(targetPath).filter((path) => path !== "/dev/null");
    } catch {
      return [];
    }
  }
  return [];
}
