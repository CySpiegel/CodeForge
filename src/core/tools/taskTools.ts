import type { CodeForgeTool } from "../toolRegistry";
import { isRecord } from "../guards";
import { invalidToolType, optionalString, optionalStringArray, parseTaskStatus, validateTaskId, validateTaskIds, validateTaskSubject } from "../toolValidation";

export const taskTools: readonly CodeForgeTool[] = [
  {
    name: "task_create",
    description: "Create a durable local task for multi-step agent work in the current VS Code chat session.",
    searchHint: "create planning task",
    risk: "state",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        owner: { type: "string" },
        blocks: { type: "array", items: { type: "string" } },
        blockedBy: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        reason: { type: "string" }
      },
      required: ["subject"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.subject === "string"
        ? {
          type: "task_create",
          subject: input.subject,
          description: optionalString(input.description),
          activeForm: optionalString(input.activeForm),
          owner: optionalString(input.owner),
          blocks: optionalStringArray(input.blocks),
          blockedBy: optionalStringArray(input.blockedBy),
          metadata: isRecord(input.metadata) ? input.metadata : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "task_create") {
        return invalidToolType(action, "task_create");
      }
      return validateTaskSubject(action.subject) ?? validateTaskIds(action.blocks) ?? validateTaskIds(action.blockedBy) ?? { ok: true };
    },
    summarize(action) {
      return action.type === "task_create" ? `Create task ${action.subject}` : "Create task";
    }
  },
  {
    name: "task_update",
    description: "Update a durable local task status, owner, description, dependencies, or metadata.",
    searchHint: "update planning task",
    risk: "state",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        owner: { type: "string" },
        blocks: { type: "array", items: { type: "string" } },
        blockedBy: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        reason: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.taskId === "string"
        ? {
          type: "task_update",
          taskId: input.taskId,
          subject: optionalString(input.subject),
          description: optionalString(input.description),
          activeForm: optionalString(input.activeForm),
          status: parseTaskStatus(input.status),
          owner: optionalString(input.owner),
          blocks: optionalStringArray(input.blocks),
          blockedBy: optionalStringArray(input.blockedBy),
          metadata: isRecord(input.metadata) ? input.metadata : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "task_update") {
        return invalidToolType(action, "task_update");
      }
      const idResult = validateTaskId(action.taskId);
      if (!idResult.ok) {
        return idResult;
      }
      if (action.subject !== undefined) {
        const subject = validateTaskSubject(action.subject);
        if (subject) {
          return subject;
        }
      }
      return validateTaskIds(action.blocks) ?? validateTaskIds(action.blockedBy) ?? { ok: true };
    },
    summarize(action) {
      return action.type === "task_update" ? `Update task ${action.taskId}` : "Update task";
    }
  },
  {
    name: "task_list",
    description: "List durable local tasks for the current chat session.",
    searchHint: "list planning tasks",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        owner: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return {
        type: "task_list",
        status: parseTaskStatus(input.status),
        owner: optionalString(input.owner),
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      return action.type === "task_list" ? { ok: true } : invalidToolType(action, "task_list");
    },
    summarize(action) {
      return action.type === "task_list" ? `List tasks${action.status ? ` with status ${action.status}` : ""}` : "List tasks";
    }
  },
  {
    name: "task_get",
    description: "Read one durable local task for the current chat session.",
    searchHint: "read planning task",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.taskId === "string" ? { type: "task_get", taskId: input.taskId, reason: optionalString(input.reason) } : undefined;
    },
    validate(action) {
      return action.type === "task_get" ? validateTaskId(action.taskId) : invalidToolType(action, "task_get");
    },
    summarize(action) {
      return action.type === "task_get" ? `Read task ${action.taskId}` : "Read task";
    }
  },
];
