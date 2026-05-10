import * as vscode from "vscode";
import {
  buildSessionSnapshot,
  createSessionId,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionSummary
} from "../core/session";
import { validateAction } from "../core/toolRegistry";
import { AgentAction, ApprovalRequest, ChatMessage, ToolCall } from "../core/types";
import { WorkerKind, WorkerSessionEvent, WorkerStatus, WorkerSummary, WorkerTranscriptEntry, WorkerTranscriptRole } from "../core/workerTypes";

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
        const record = toSessionRecord(JSON.parse(line));
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

function toSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isObject(value) || typeof value.type !== "string" || typeof value.sessionId !== "string" || typeof value.createdAt !== "number") {
    return undefined;
  }

  switch (value.type) {
    case "session_started":
      return typeof value.title === "string"
        ? {
          type: "session_started",
          sessionId: value.sessionId,
          createdAt: value.createdAt,
          schemaVersion: 1,
          title: value.title
        }
        : undefined;
    case "message": {
      const message = toChatMessage(value.message);
      return message ? { type: "message", sessionId: value.sessionId, createdAt: value.createdAt, message } : undefined;
    }
    case "messages_replaced": {
      const rawMessages = value.messages;
      const messages = Array.isArray(rawMessages) ? rawMessages.map(toChatMessage) : [];
      if (!Array.isArray(rawMessages) || messages.some((message) => !message) || !isReplacementReason(value.reason)) {
        return undefined;
      }
      const chatMessages = messages.filter((message): message is ChatMessage => Boolean(message));
      return {
        type: "messages_replaced",
        sessionId: value.sessionId,
        createdAt: value.createdAt,
        messages: chatMessages,
        reason: value.reason
      };
    }
    case "approval_requested":
      return isApprovalRequest(value.approval)
        ? { type: "approval_requested", sessionId: value.sessionId, createdAt: value.createdAt, approval: value.approval }
        : undefined;
    case "approval_resolved":
      return typeof value.approvalId === "string" && typeof value.accepted === "boolean" && typeof value.text === "string"
        ? {
          type: "approval_resolved",
          sessionId: value.sessionId,
          createdAt: value.createdAt,
          approvalId: value.approvalId,
          accepted: value.accepted,
          text: value.text
        }
        : undefined;
    case "checkpoint": {
      const action = toAgentAction(value.action);
      return action && typeof value.summary === "string"
        ? {
          type: "checkpoint",
          sessionId: value.sessionId,
          createdAt: value.createdAt,
          action,
          summary: value.summary
        }
        : undefined;
    }
    case "worker": {
      const worker = toWorkerSummary(value.worker);
      const transcriptEntry = value.transcriptEntry === undefined ? undefined : toWorkerTranscriptEntry(value.transcriptEntry);
      return worker && isWorkerSessionEvent(value.event) && (value.transcriptEntry === undefined || transcriptEntry)
        ? {
          type: "worker",
          sessionId: value.sessionId,
          createdAt: value.createdAt,
          event: value.event,
          worker,
          transcriptEntry
        }
        : undefined;
    }
    case "event":
      return isEventLevel(value.level) && typeof value.text === "string"
        ? { type: "event", sessionId: value.sessionId, createdAt: value.createdAt, level: value.level, text: value.text }
        : undefined;
    default:
      return undefined;
  }
}

function toChatMessage(value: unknown): ChatMessage | undefined {
  if (!isObject(value) || !isChatRole(value.role) || typeof value.content !== "string") {
    return undefined;
  }
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.map(toToolCall) : undefined;
  if (toolCalls?.some((toolCall) => !toolCall)) {
    return undefined;
  }
  const parsedToolCalls = toolCalls?.filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
  return {
    role: value.role,
    content: value.content,
    name: typeof value.name === "string" ? value.name : undefined,
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    toolCalls: parsedToolCalls
  };
}

function toToolCall(value: unknown): ToolCall | undefined {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.argumentsJson === "string"
    ? { id: value.id, name: value.name, argumentsJson: value.argumentsJson }
    : undefined;
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return isObject(value)
    && typeof value.id === "string"
    && isApprovalKind(value.kind)
    && typeof value.title === "string"
    && typeof value.summary === "string"
    && typeof value.createdAt === "number"
    && toAgentAction(value.action) !== undefined;
}

function toAgentAction(value: unknown): AgentAction | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const action = value as unknown as AgentAction;
  return validateAction(action).ok ? action : undefined;
}

function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isApprovalKind(value: unknown): value is ApprovalRequest["kind"] {
  return value === "read" || value === "search" || value === "edit" || value === "preview" || value === "command" || value === "service";
}

function isReplacementReason(value: unknown): value is "compact" | "restore" {
  return value === "compact" || value === "restore";
}

function toWorkerSummary(value: unknown): WorkerSummary | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !isWorkerKind(value.kind) || !isWorkerStatus(value.status) || typeof value.prompt !== "string" || typeof value.startedAt !== "number" || typeof value.updatedAt !== "number" || typeof value.toolUseCount !== "number" || typeof value.tokenCount !== "number") {
    return undefined;
  }
  const filesInspected = Array.isArray(value.filesInspected)
    ? value.filesInspected.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: value.id,
    kind: value.kind,
    label: typeof value.label === "string" ? value.label : value.kind,
    status: value.status,
    prompt: value.prompt,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    profileLabel: typeof value.profileLabel === "string" ? value.profileLabel : undefined,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined,
    toolUseCount: value.toolUseCount,
    tokenCount: value.tokenCount,
    filesInspected
  };
}

function toWorkerTranscriptEntry(value: unknown): WorkerTranscriptEntry | undefined {
  return isObject(value) && typeof value.workerId === "string" && typeof value.createdAt === "number" && isWorkerTranscriptRole(value.role) && typeof value.text === "string"
    ? {
      workerId: value.workerId,
      createdAt: value.createdAt,
      role: value.role,
      text: value.text
    }
    : undefined;
}

function isWorkerKind(value: unknown): value is WorkerKind {
  return value === "explore" || value === "plan" || value === "review" || value === "verify";
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "stopped";
}

function isWorkerTranscriptRole(value: unknown): value is WorkerTranscriptRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" || value === "status";
}

function isWorkerSessionEvent(value: unknown): value is WorkerSessionEvent {
  return value === "started" || value === "progress" || value === "completed" || value === "failed" || value === "stopped";
}

function isEventLevel(value: unknown): value is "status" | "error" {
  return value === "status" || value === "error";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
