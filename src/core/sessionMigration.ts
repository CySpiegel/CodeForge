import { validateAction } from "./toolRegistry";
import { AgentAction, ApprovalRequest, ChatMessage, CodeForgeTask, CodeForgeTaskStatus, ToolCall } from "./types";
import { WorkerKind, WorkerSessionEvent, WorkerStatus, WorkerSummary, WorkerTranscriptEntry, WorkerTranscriptRole } from "./workerTypes";
import { SessionRecord } from "./session";

export function normalizeSessionRecord(value: unknown): SessionRecord | undefined {
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
    case "task": {
      const task = toCodeForgeTask(value.task);
      return task && (value.event === "created" || value.event === "updated")
        ? {
          type: "task",
          sessionId: value.sessionId,
          createdAt: value.createdAt,
          event: value.event,
          task
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

function toCodeForgeTask(value: unknown): CodeForgeTask | undefined {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.subject !== "string" || !isTaskStatus(value.status) || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
    return undefined;
  }
  return {
    id: value.id,
    subject: value.subject,
    description: typeof value.description === "string" ? value.description : undefined,
    activeForm: typeof value.activeForm === "string" ? value.activeForm : undefined,
    status: value.status,
    owner: typeof value.owner === "string" ? value.owner : undefined,
    blocks: Array.isArray(value.blocks) ? value.blocks.filter((item): item is string => typeof item === "string") : [],
    blockedBy: Array.isArray(value.blockedBy) ? value.blockedBy.filter((item): item is string => typeof item === "string") : [],
    metadata: isObject(value.metadata) ? value.metadata : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined
  };
}

function isTaskStatus(value: unknown): value is CodeForgeTaskStatus {
  return value === "pending" || value === "in_progress" || value === "blocked" || value === "completed" || value === "cancelled";
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
  return value === "read" || value === "search" || value === "automation" || value === "question" || value === "memory" || value === "state" || value === "edit" || value === "preview" || value === "command" || value === "service";
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
  return value === "explore" || value === "plan" || value === "review" || value === "verify" || value === "implement" || value === "custom";
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
