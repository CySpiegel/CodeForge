import {
  AgentAction,
  GlobFilesAction,
  GrepTextAction,
  ListDiagnosticsAction,
  ListFilesAction,
  ReadFileAction,
  SearchTextAction
} from "./types";

// Pure action-classification predicates: they decide an action's category purely from its `type`,
// independent of the tool-registry table. (Table-property lookups like requiresApproval/concurrencySafe
// — isApprovalAction / isConcurrencySafeAction — stay in toolRegistry next to `codeForgeTools`.)

export function isLocalReadOnlyAction(action: AgentAction): action is ListFilesAction | GlobFilesAction | ReadFileAction | SearchTextAction | GrepTextAction | ListDiagnosticsAction {
  return action.type === "list_files"
    || action.type === "glob_files"
    || action.type === "read_file"
    || action.type === "search_text"
    || action.type === "grep_text"
    || action.type === "list_diagnostics";
}

export function isReadOnlyAction(action: AgentAction): boolean {
  return isLocalReadOnlyAction(action)
    || action.type === "ask_user_question"
    || action.type === "tool_search"
    || action.type === "tool_list"
    || action.type === "task_list"
    || action.type === "task_get"
    || action.type === "code_hover"
    || action.type === "code_definition"
    || action.type === "code_references"
    || action.type === "code_symbols"
    || action.type === "mcp_list_resources"
    || action.type === "mcp_read_resource"
    || action.type === "notebook_read"
    || action.type === "open_diff"
    || action.type === "spawn_agent"
    || action.type === "worker_output"
    || action.type === "git";
}

// Internal automation actions (worker orchestration) — surfaced differently from user-visible work.
export function isInternalAutomationAction(action: AgentAction): boolean {
  return action.type === "spawn_agent" || action.type === "worker_output";
}

// Internal task-board mutations — state bookkeeping rather than user-facing edits.
export function isInternalStateAction(action: AgentAction): boolean {
  return action.type === "task_create" || action.type === "task_update";
}

// Internal read/inspection actions — discovery the agent does for itself, not user-requested output.
export function isInternalReadAction(action: AgentAction): boolean {
  return action.type === "tool_list"
    || action.type === "tool_search"
    || action.type === "task_list"
    || action.type === "task_get"
    || action.type === "code_hover"
    || action.type === "code_definition"
    || action.type === "code_references"
    || action.type === "code_symbols"
    || action.type === "mcp_list_resources"
    || action.type === "mcp_read_resource"
    || action.type === "notebook_read"
    || action.type === "skill_view"
    || action.type === "skills_list"
    || action.type === "fact_store"
    || action.type === "fact_feedback";
}
