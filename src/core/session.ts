import { AgentAction, ApprovalRequest, ChatMessage } from "./types";

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pendingApprovalCount: number;
}

export interface SessionSnapshot extends SessionSummary {
  readonly messages: readonly ChatMessage[];
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly records: readonly SessionRecord[];
}

export type SessionRecord =
  | SessionStartedRecord
  | SessionMessageRecord
  | SessionMessagesReplacedRecord
  | SessionApprovalRequestedRecord
  | SessionApprovalResolvedRecord
  | SessionCheckpointRecord
  | SessionEventRecord;

export interface SessionStartedRecord {
  readonly type: "session_started";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly schemaVersion: 1;
  readonly title: string;
}

export interface SessionMessageRecord {
  readonly type: "message";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly message: ChatMessage;
}

export interface SessionMessagesReplacedRecord {
  readonly type: "messages_replaced";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly messages: readonly ChatMessage[];
  readonly reason: "compact" | "restore";
}

export interface SessionApprovalRequestedRecord {
  readonly type: "approval_requested";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly approval: ApprovalRequest;
}

export interface SessionApprovalResolvedRecord {
  readonly type: "approval_resolved";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly approvalId: string;
  readonly accepted: boolean;
  readonly text: string;
}

export interface SessionCheckpointRecord {
  readonly type: "checkpoint";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly action: AgentAction;
  readonly summary: string;
}

export interface SessionEventRecord {
  readonly type: "event";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly level: "status" | "error";
  readonly text: string;
}

export interface SessionStore {
  createSession(title: string): Promise<SessionSnapshot>;
  append(record: SessionRecord): Promise<void>;
  read(sessionId: string): Promise<SessionSnapshot | undefined>;
  readLatest(): Promise<SessionSnapshot | undefined>;
  list(limit: number): Promise<readonly SessionSummary[]>;
  exportSession(sessionId: string): Promise<string | undefined>;
}

export function buildSessionSnapshot(records: readonly SessionRecord[]): SessionSnapshot | undefined {
  const started = records.find((record): record is SessionStartedRecord => record.type === "session_started");
  if (!started) {
    return undefined;
  }

  const messages: ChatMessage[] = [];
  const pendingApprovals = new Map<string, ApprovalRequest>();
  let updatedAt = started.createdAt;

  for (const record of records) {
    updatedAt = Math.max(updatedAt, record.createdAt);
    if (record.type === "message") {
      messages.push(record.message);
    } else if (record.type === "messages_replaced") {
      messages.splice(0, messages.length, ...record.messages);
    } else if (record.type === "approval_requested") {
      pendingApprovals.set(record.approval.id, record.approval);
    } else if (record.type === "approval_resolved") {
      pendingApprovals.delete(record.approvalId);
    }
  }

  return {
    id: started.sessionId,
    title: started.title,
    createdAt: started.createdAt,
    updatedAt,
    messageCount: messages.length,
    pendingApprovalCount: pendingApprovals.size,
    messages,
    pendingApprovals: [...pendingApprovals.values()].sort((a, b) => a.createdAt - b.createdAt),
    records
  };
}

export function createSessionId(now = Date.now()): string {
  return `session-${now}-${Math.random().toString(16).slice(2)}`;
}
