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
      origin: metadata.origin,
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
  readonly origin?: ApprovalRequest["origin"];
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
    case "spawn_agent":
    case "worker_output":
      return "automation";
    case "ask_user_question":
      return "question";
    case "memory_write":
      return "memory";
    case "tool_search":
    case "tool_list":
    case "task_list":
    case "task_get":
    case "code_hover":
    case "code_definition":
    case "code_references":
    case "code_symbols":
    case "mcp_list_resources":
    case "mcp_read_resource":
    case "notebook_read":
      return "read";
    case "task_create":
    case "task_update":
      return "state";
    case "open_diff":
      return "preview";
    case "write_file":
    case "edit_file":
    case "notebook_edit_cell":
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
    case "spawn_agent":
      return "Launch agent";
    case "worker_output":
      return "Read worker output";
    case "ask_user_question":
      return "Answer question";
    case "memory_write":
      return "Save memory";
    case "tool_search":
      return "Search tools";
    case "tool_list":
      return "List tools";
    case "task_create":
      return "Create task";
    case "task_update":
      return "Update task";
    case "task_list":
      return "List tasks";
    case "task_get":
      return "Read task";
    case "code_hover":
      return "Read hover";
    case "code_definition":
      return "Find definition";
    case "code_references":
      return "Find references";
    case "code_symbols":
      return "List symbols";
    case "mcp_list_resources":
      return "List MCP resources";
    case "mcp_read_resource":
      return "Read MCP resource";
    case "notebook_read":
      return "Read notebook";
    case "notebook_edit_cell":
      return "Edit notebook cell";
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
    case "spawn_agent":
    case "worker_output":
      return "local agent automation";
    case "ask_user_question":
      return "requires user answer";
    case "memory_write":
      return "persistent local memory";
    case "tool_search":
    case "tool_list":
    case "task_list":
    case "task_get":
    case "code_hover":
    case "code_definition":
    case "code_references":
    case "code_symbols":
    case "notebook_read":
      return "read-only local state";
    case "task_create":
    case "task_update":
      return "local session task state";
    case "mcp_list_resources":
    case "mcp_read_resource":
      return "configured local service resource";
    case "open_diff":
      return "VS Code diff preview";
    case "write_file":
    case "edit_file":
    case "notebook_edit_cell":
    case "propose_patch":
      return "workspace edit";
    case "run_command":
      return classifyShellCommand(action.command).summary;
    case "mcp_call_tool":
      return "configured local service tool";
  }
}
