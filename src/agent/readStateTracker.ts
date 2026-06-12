import { normalizeWorkspacePathInput } from "../core/workspacePaths";

export interface ReadFileSnapshot {
  readonly content: string;
  readonly maxBytes: number;
  readonly readAt: number;
  readonly source: "tool" | "worker";
}

// Owns the read-state bookkeeping behind the writable-action stale-read guard: a per-file snapshot of
// what was last read (so an edit/write can detect it was never read or has since changed) and the set of
// notebooks that have been read. Pure state — the guard logic and file I/O stay in the controller; this
// module just stores, normalizing every path to a stable key so lookups match regardless of input form.
export class ReadStateTracker {
  private readonly readFileState = new Map<string, ReadFileSnapshot>();
  private readonly notebookReadState = new Set<string>();

  remember(path: string, content: string, maxBytes: number, source: ReadFileSnapshot["source"]): void {
    this.readFileState.set(readStateKey(path), {
      content,
      maxBytes,
      readAt: Date.now(),
      source
    });
  }

  snapshotFor(path: string): ReadFileSnapshot | undefined {
    return this.readFileState.get(readStateKey(path));
  }

  forget(path: string): void {
    this.readFileState.delete(readStateKey(path));
  }

  hasNotebookRead(path: string): boolean {
    return this.notebookReadState.has(readStateKey(path));
  }

  markNotebookRead(path: string): void {
    this.notebookReadState.add(readStateKey(path));
  }

  clear(): void {
    this.readFileState.clear();
    this.notebookReadState.clear();
  }
}

function readStateKey(path: string): string {
  return normalizeWorkspacePathInput(path).replace(/^\/+/, "").replace(/^\.\//, "");
}

// Extract the raw file content from a read_file tool result string (stripping the "read_file <path>"
// header) so it can be remembered as the read snapshot.
export function readFileContentFromToolResult(result: string, path: string): string {
  const prefix = `read_file ${path}\n\n`;
  return result.startsWith(prefix) ? result.slice(prefix.length) : result.replace(/^read_file[^\n]*\n\n/, "");
}
