import { ToolInvocation, toolSummary } from "../core/toolRegistry";
import { AgentAction, ApprovalRequest, PermissionDecision, UserQuestion } from "../core/types";

// Pure presentation builders for the approval flow: the strings and value objects shown to the user or
// fed back into the transcript when an action is approved, rejected, or answered. The approval control
// flow itself stays in the controller; this module only formats.

export function formatQuestionAnswers(questions: readonly UserQuestion[], answers: Readonly<Record<string, string>>): string {
  const lines = questions.map((question) => `- ${question.question} -> ${answers[question.question]}`);
  return `ask_user_question\n\nUser answered CodeForge's question(s):\n${lines.join("\n")}\n\nContinue with these answers in mind.`;
}

export function approvalPermissionDecision(approval: ApprovalRequest): PermissionDecision {
  return {
    behavior: "ask",
    source: approval.permissionSource ?? "mode",
    reason: approval.permissionReason ?? "Approval was requested by the current permission policy."
  };
}

export function invocationForApproval(approval: ApprovalRequest): ToolInvocation {
  return {
    id: approval.toolCallId ?? approval.id,
    action: approval.action,
    source: approval.toolCallId ? "native" : "json",
    toolCallId: approval.toolCallId
  };
}

export function approvalAcceptedText(action: AgentAction, transcriptResult: string): string {
  switch (action.type) {
    case "list_files":
      return "Listed files.";
    case "glob_files":
      return `Found files matching ${action.pattern}.`;
    case "read_file":
      return `Read ${action.path}.`;
    case "search_text":
      return `Searched for ${action.query}.`;
    case "grep_text":
      return `Searched for ${action.query}.`;
    case "list_diagnostics":
      return action.path ? `Listed diagnostics for ${action.path}.` : "Listed workspace diagnostics.";
    case "git":
      return `Ran git ${action.operation}.`;
    case "spawn_agent":
      return `Launched agent ${action.agent || "implement"}.`;
    case "worker_output":
      return `Read worker output ${action.workerId}.`;
    case "ask_user_question":
      return "Answered question.";
    case "tool_list":
      return "Listed tools.";
    case "tool_search":
      return `Loaded tool schemas for ${action.query}.`;
    case "task_create":
      return "Created task.";
    case "task_update":
      return `Updated task ${action.taskId}.`;
    case "task_list":
      return "Listed tasks.";
    case "task_get":
      return `Read task ${action.taskId}.`;
    case "code_hover":
      return `Read hover at ${action.path}:${action.line}:${action.character}.`;
    case "code_definition":
      return `Found definitions at ${action.path}:${action.line}:${action.character}.`;
    case "code_references":
      return `Found references at ${action.path}:${action.line}:${action.character}.`;
    case "code_symbols":
      return "Listed code symbols.";
    case "mcp_list_resources":
      return "Listed MCP resources.";
    case "mcp_read_resource":
      return `Read MCP resource ${action.serverId}:${action.uri}.`;
    case "notebook_read":
      return `Read notebook ${action.path}.`;
    case "notebook_edit_cell":
      return `Edited notebook ${action.path} cell ${action.index}.`;
    case "memory":
      return "Updated curated memory.";
    case "fact_store":
      return `Durable memory: ${action.action}.`;
    case "fact_feedback":
      return "Rated a durable fact.";
    case "skill_manage":
      return `Skill ${action.action}: ${action.name}.`;
    case "skill_view":
      return `Viewed skill ${action.name}.`;
    case "skills_list":
      return "Listed skills.";
    case "write_file":
      return `Wrote ${action.path}.`;
    case "edit_file":
      return `Edited ${action.path}.`;
    case "open_diff":
      return "Opened diff preview.";
    case "propose_patch":
      return transcriptResult.split("\n").find((line) => line.startsWith("Applied changes")) ?? "Applied proposed edit.";
    case "run_command": {
      const status = transcriptResult.split("\n").find((line) => line.startsWith("Status:"));
      return status ? `Command ${status.slice("Status: ".length)}.` : "Command finished.";
    }
    case "mcp_call_tool":
      return `Called MCP ${action.serverId}/${action.toolName}.`;
  }
}

export function approvalContinuationPrompt(action: AgentAction, outcome: "accepted" | "failed" | "rejected"): string {
  const summary = toolSummary(action);
  if (outcome === "accepted") {
    return `CodeForge continuation: The user approved ${summary}. Continue the original task from the existing plan. If more edits, commands, or tool calls are still needed, request the next one now. Do not stop until the user's task is complete.`;
  }
  if (outcome === "rejected") {
    return `CodeForge continuation: The user rejected ${summary}. Continue the original task by choosing an alternative allowed approach. Do not retry the same rejected action unchanged.`;
  }
  return `CodeForge continuation: ${summary} was approved but failed. Continue the original task by inspecting the current state and trying a corrected approach. Do not repeat the same failed action unchanged.`;
}
