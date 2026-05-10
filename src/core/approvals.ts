import { AgentAction, ApprovalKind, ApprovalRequest, PermissionDecision } from "./types";
import { classifyShellCommand } from "./shellSemantics";
import { toolSummary } from "./toolRegistry";

export class ApprovalQueue {
  private readonly pending = new Map<string, ApprovalRequest>();

  createForAction(action: AgentAction, permission: PermissionDecision, toolCallId?: string, metadata: ApprovalMetadata = {}): ApprovalRequest {
    const id = `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request: ApprovalRequest = {
      id,
      kind: approvalKind(action),
      title: titleForAction(action),
      summary: action.reason ?? summarizeAction(action),
      detail: metadata.detail ?? summarizeAction(action),
      risk: metadata.risk ?? riskForAction(action),
      permissionReason: permission.reason,
      permissionSource: permission.source,
      toolCallId,
      toolName: action.type,
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

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id);
  }

  reject(id: string): boolean {
    return this.pending.delete(id);
  }

  clear(): void {
    this.pending.clear();
  }

  restore(approvals: readonly ApprovalRequest[]): void {
    this.pending.clear();
    for (const approval of approvals) {
      this.pending.set(approval.id, approval);
    }
  }

  list(): readonly ApprovalRequest[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

export interface ApprovalMetadata {
  readonly detail?: string;
  readonly risk?: string;
}

function summarizeAction(action: AgentAction): string {
  return toolSummary(action);
}

function approvalKind(action: AgentAction): ApprovalKind {
  switch (action.type) {
    case "list_files":
    case "glob_files":
    case "read_file":
      return "read";
    case "search_text":
    case "grep_text":
    case "list_diagnostics":
      return "search";
    case "open_diff":
      return "preview";
    case "write_file":
    case "edit_file":
    case "propose_patch":
      return "edit";
    case "run_command":
      return "command";
    case "mcp_call_tool":
      return "service";
  }
}

function titleForAction(action: AgentAction): string {
  switch (action.type) {
    case "list_files":
      return "List files";
    case "glob_files":
      return "Find files";
    case "read_file":
      return "Read file";
    case "search_text":
    case "grep_text":
    case "list_diagnostics":
      return "Search workspace";
    case "open_diff":
      return "Open diff preview";
    case "write_file":
      return "Write file";
    case "edit_file":
      return "Edit file";
    case "propose_patch":
      return "Apply proposed edit";
    case "run_command":
      return "Run command";
    case "mcp_call_tool":
      return "Call MCP tool";
  }
}

function riskForAction(action: AgentAction): string {
  switch (action.type) {
    case "list_files":
    case "glob_files":
    case "read_file":
    case "search_text":
    case "grep_text":
    case "list_diagnostics":
      return "read-only workspace access";
    case "open_diff":
      return "VS Code diff preview";
    case "write_file":
    case "edit_file":
    case "propose_patch":
      return "workspace edit";
    case "run_command":
      return classifyShellCommand(action.command).summary;
    case "mcp_call_tool":
      return "configured local service tool";
  }
}
