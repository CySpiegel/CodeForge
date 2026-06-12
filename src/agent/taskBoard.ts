import { SessionRecord } from "../core/session";
import { AgentAction, CodeForgeTask } from "../core/types";
import { toolError } from "./toolText";

export interface TaskBoardDeps {
  // Persist a task event into the current session (lazily creating the session); no-op without a store.
  record(factory: (sessionId: string) => SessionRecord): Promise<void>;
  publishState(): Promise<void>;
}

// Owns the in-memory task board backing the task_create/update/list/get tools. Mutations are persisted
// as session "task" records and rehydrated on session restore, so the board survives reloads. Purely
// model-facing — the controller routes the four tool actions plus reset/restore here.
export class TaskBoard {
  private tasks = new Map<string, CodeForgeTask>();

  constructor(private readonly deps: TaskBoardDeps) {}

  reset(): void {
    this.tasks.clear();
  }

  restoreFromSessionRecords(records: readonly SessionRecord[]): void {
    this.tasks.clear();
    for (const record of records) {
      if (record.type === "task") {
        this.tasks.set(record.task.id, record.task);
      }
    }
  }

  async createTask(action: Extract<AgentAction, { readonly type: "task_create" }>): Promise<string> {
    const now = Date.now();
    const task: CodeForgeTask = {
      id: `task-${now}-${Math.random().toString(16).slice(2)}`,
      subject: action.subject.trim(),
      description: action.description?.trim() || undefined,
      activeForm: action.activeForm?.trim() || undefined,
      status: "pending",
      owner: action.owner?.trim() || undefined,
      blocks: uniqueStrings(action.blocks),
      blockedBy: uniqueStrings(action.blockedBy),
      metadata: action.metadata,
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(task.id, task);
    await this.recordTask(task, "created");
    await this.deps.publishState();
    return `task_create ${task.id}\n\n${formatTask(task)}`;
  }

  async updateTask(action: Extract<AgentAction, { readonly type: "task_update" }>): Promise<string> {
    const existing = this.tasks.get(action.taskId);
    if (!existing) {
      return toolError(`No task found for ${action.taskId}.`);
    }
    const now = Date.now();
    const nextStatus = action.status ?? existing.status;
    const task: CodeForgeTask = {
      ...existing,
      subject: action.subject?.trim() || existing.subject,
      description: action.description !== undefined ? action.description.trim() || undefined : existing.description,
      activeForm: action.activeForm !== undefined ? action.activeForm.trim() || undefined : existing.activeForm,
      status: nextStatus,
      owner: action.owner !== undefined ? action.owner.trim() || undefined : existing.owner,
      blocks: action.blocks !== undefined ? uniqueStrings(action.blocks) : existing.blocks,
      blockedBy: action.blockedBy !== undefined ? uniqueStrings(action.blockedBy) : existing.blockedBy,
      metadata: action.metadata !== undefined ? { ...(existing.metadata ?? {}), ...action.metadata } : existing.metadata,
      updatedAt: now,
      completedAt: nextStatus === "completed" ? existing.completedAt ?? now : nextStatus === "cancelled" ? existing.completedAt ?? now : existing.completedAt
    };
    this.tasks.set(task.id, task);
    await this.recordTask(task, "updated");
    await this.deps.publishState();
    return `task_update ${task.id}\n\n${formatTask(task)}`;
  }

  listTasks(action: Extract<AgentAction, { readonly type: "task_list" }>): string {
    const tasks = [...this.tasks.values()]
      .filter((task) => !action.status || task.status === action.status)
      .filter((task) => !action.owner || task.owner === action.owner)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (tasks.length === 0) {
      return "task_list\n\nNo tasks.";
    }
    return `task_list\n\n${tasks.map(formatTaskLine).join("\n")}`;
  }

  getTask(taskId: string): string {
    const task = this.tasks.get(taskId);
    return task ? `task_get ${task.id}\n\n${formatTask(task)}` : toolError(`No task found for ${taskId}.`);
  }

  private async recordTask(task: CodeForgeTask, event: "created" | "updated"): Promise<void> {
    await this.deps.record((sessionId) => ({
      type: "task",
      sessionId,
      createdAt: Date.now(),
      event,
      task
    }));
  }
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function formatTaskLine(task: CodeForgeTask): string {
  const owner = task.owner ? ` owner=${task.owner}` : "";
  const blockedBy = task.blockedBy.length > 0 ? ` blockedBy=${task.blockedBy.join(",")}` : "";
  return `- ${task.id} [${task.status}]${owner}${blockedBy} ${task.subject}`;
}

function formatTask(task: CodeForgeTask): string {
  return [
    `ID: ${task.id}`,
    `Status: ${task.status}`,
    `Subject: ${task.subject}`,
    task.description ? `Description: ${task.description}` : undefined,
    task.activeForm ? `Active: ${task.activeForm}` : undefined,
    task.owner ? `Owner: ${task.owner}` : undefined,
    task.blocks.length > 0 ? `Blocks: ${task.blocks.join(", ")}` : undefined,
    task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.join(", ")}` : undefined,
    task.metadata && Object.keys(task.metadata).length > 0 ? `Metadata: ${JSON.stringify(task.metadata)}` : undefined,
    `Created: ${new Date(task.createdAt).toISOString()}`,
    `Updated: ${new Date(task.updatedAt).toISOString()}`,
    task.completedAt ? `Completed: ${new Date(task.completedAt).toISOString()}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n");
}
