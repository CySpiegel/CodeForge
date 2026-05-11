import * as vscode from "vscode";
import {
  buildSessionSnapshot,
  createSessionId,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionSummary
} from "../core/session";
import { normalizeSessionRecord } from "../core/sessionMigration";

const latestSessionKey = "codeforge.sessions.latest";
const sessionFileExtension = ".jsonl";

export class VsCodeSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async createSession(title: string): Promise<SessionSnapshot> {
    const now = Date.now();
    const sessionId = createSessionId(now);
    const record: SessionRecord = {
      type: "session_started",
      sessionId,
      createdAt: now,
      schemaVersion: 1,
      title: title.trim() || "CodeForge session"
    };
    await this.writeRecords(sessionId, [record]);
    await this.context.workspaceState.update(latestSessionKey, sessionId);

    const snapshot = buildSessionSnapshot([record]);
    if (!snapshot) {
      throw new Error("Failed to create a CodeForge session snapshot.");
    }
    return snapshot;
  }

  append(record: SessionRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(
      () => this.appendNow(record),
      () => this.appendNow(record)
    );
    return this.writeQueue;
  }

  async read(sessionId: string): Promise<SessionSnapshot | undefined> {
    if (!isSafeSessionId(sessionId)) {
      return undefined;
    }
    await this.flushPendingWrites();
    return buildSessionSnapshot(await this.readRecords(sessionId));
  }

  async readLatest(): Promise<SessionSnapshot | undefined> {
    const latestSessionId = this.context.workspaceState.get<string>(latestSessionKey);
    if (latestSessionId) {
      const latest = await this.read(latestSessionId);
      if (latest) {
        return latest;
      }
    }

    const [mostRecent] = await this.readSnapshots(1);
    return mostRecent;
  }

  async list(limit: number): Promise<readonly SessionSummary[]> {
    const snapshots = await this.readSnapshots(Math.max(1, limit));
    return snapshots.map((snapshot): SessionSummary => ({
      id: snapshot.id,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      messageCount: snapshot.messageCount,
      pendingApprovalCount: snapshot.pendingApprovalCount
    }));
  }

  async exportSession(sessionId: string): Promise<string | undefined> {
    const snapshot = await this.read(sessionId);
    if (!snapshot) {
      return undefined;
    }

    const exportUri = vscode.Uri.joinPath(this.exportsRoot(), `${sessionId}.json`);
    await vscode.workspace.fs.createDirectory(this.exportsRoot());
    await vscode.workspace.fs.writeFile(
      exportUri,
      Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), ...snapshot }, null, 2), "utf8")
    );
    return exportUri.fsPath || exportUri.toString();
  }

  private async appendNow(record: SessionRecord): Promise<void> {
    const current = await this.readText(record.sessionId);
    const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
    await this.writeText(record.sessionId, `${prefix}${JSON.stringify(record)}\n`);
    await this.context.workspaceState.update(latestSessionKey, record.sessionId);
  }

  private async readSnapshots(limit: number): Promise<readonly SessionSnapshot[]> {
    await this.flushPendingWrites();
    const root = this.sessionsRoot();
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
      return [];
    }

    const snapshots: SessionSnapshot[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(sessionFileExtension)) {
        continue;
      }
      const sessionId = name.slice(0, -sessionFileExtension.length);
      if (!isSafeSessionId(sessionId)) {
        continue;
      }
      const snapshot = buildSessionSnapshot(await this.readRecords(sessionId));
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  private async readRecords(sessionId: string): Promise<readonly SessionRecord[]> {
    const text = await this.readText(sessionId);
    const records: SessionRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = normalizeSessionRecord(JSON.parse(line));
        if (record) {
          records.push(record);
        }
      } catch {
        // Ignore corrupt JSONL records so one bad line does not lose the whole session.
      }
    }
    return records;
  }

  private async readText(sessionId: string): Promise<string> {
    if (!isSafeSessionId(sessionId)) {
      return "";
    }
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(this.sessionUri(sessionId))).toString("utf8");
    } catch {
      return "";
    }
  }

  private async writeRecords(sessionId: string, records: readonly SessionRecord[]): Promise<void> {
    await this.writeText(sessionId, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }

  private async writeText(sessionId: string, text: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.sessionsRoot());
    await vscode.workspace.fs.writeFile(this.sessionUri(sessionId), Buffer.from(text, "utf8"));
  }

  private async flushPendingWrites(): Promise<void> {
    try {
      await this.writeQueue;
    } catch {
      // The next append retries on the queue rejection path; reads should still return what is on disk.
    }
  }

  private sessionUri(sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.sessionsRoot(), `${sessionId}${sessionFileExtension}`);
  }

  private sessionsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, "sessions");
  }

  private exportsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, "exports");
  }
}

function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}
