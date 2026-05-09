import { ApprovalRequest, ProposePatchAction, RunCommandAction } from "./types";

export class ApprovalQueue {
  private readonly pending = new Map<string, ApprovalRequest>();

  createForAction(action: ProposePatchAction | RunCommandAction): ApprovalRequest {
    const id = `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request: ApprovalRequest = {
      id,
      kind: action.type === "propose_patch" ? "edit" : "command",
      title: action.type === "propose_patch" ? "Apply proposed edit" : "Run command",
      summary: action.reason ?? summarizeAction(action),
      action,
      createdAt: Date.now()
    };
    this.pending.set(id, request);
    return request;
  }

  take(id: string): ApprovalRequest | undefined {
    const approval = this.pending.get(id);
    if (approval) {
      this.pending.delete(id);
    }
    return approval;
  }

  reject(id: string): boolean {
    return this.pending.delete(id);
  }

  clear(): void {
    this.pending.clear();
  }

  list(): readonly ApprovalRequest[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

function summarizeAction(action: ProposePatchAction | RunCommandAction): string {
  if (action.type === "run_command") {
    return action.command;
  }
  return "Review and apply a unified diff patch.";
}
