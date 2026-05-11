import { WorkerDefinition, WorkerKind } from "./workerTypes";

const readOnlyTools = ["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics"] as const;
const codeIntelTools = ["code_hover", "code_definition", "code_references", "code_symbols"] as const;
const notebookReadTools = ["notebook_read"] as const;
const taskTools = ["tool_search", "tool_list", "task_create", "task_update", "task_list", "task_get"] as const;
const questionTools = ["ask_user_question"] as const;
const editTools = [...readOnlyTools, ...notebookReadTools, "open_diff", "propose_patch", "write_file", "edit_file", "notebook_edit_cell"] as const;
const verifyTools = [...readOnlyTools, ...codeIntelTools, ...notebookReadTools, "run_command", "tool_list", "task_list", "task_get", "task_update"] as const;
const implementTools = [...editTools, ...codeIntelTools, ...taskTools, ...questionTools] as const;

const readOnlyGuard = [
  "You are a CodeForge background worker running inside VS Code.",
  "This is a local/offline-first extension workflow. Use only the configured local or on-prem OpenAI API endpoint and CodeForge-provided workspace tools.",
  "You are strictly read-only in this worker slice.",
  "Do not create, modify, delete, move, copy, or write files.",
  "Do not run terminal commands.",
  "Do not call MCP service tools.",
  "Do not ask the user questions. Finish with a concise report.",
  "When reporting, include these plain labels: Scope, Result, Key files, Files changed, Issues, Confidence.",
  "Files changed must be 'none'."
].join("\n");

export const workerDefinitions: readonly WorkerDefinition[] = [
  {
    kind: "explore",
    label: "Explore",
    slashCommand: "/explore",
    description: "Fast read-only codebase exploration.",
    maxTurns: 5,
    allowedToolNames: [...readOnlyTools, ...codeIntelTools, ...notebookReadTools, "tool_search", "tool_list"],
    systemPrompt: [
      readOnlyGuard,
      "",
      "Specialty: quickly search and read the workspace to answer codebase questions.",
      "Use broad search first when paths are unknown, then read the smallest set of relevant files.",
      "Prefer grep_text, glob_files, list_files, read_file, and list_diagnostics over speculation.",
      "Keep the final report focused on concrete file paths and observed behavior."
    ].join("\n")
  },
  {
    kind: "plan",
    label: "Plan",
    slashCommand: "/worker plan",
    description: "Read-only implementation planning.",
    maxTurns: 6,
    allowedToolNames: [...readOnlyTools, ...codeIntelTools, ...notebookReadTools, "tool_search", "tool_list", "task_list", "task_get"],
    systemPrompt: [
      readOnlyGuard,
      "",
      "Specialty: inspect the codebase and produce an implementation plan.",
      "Identify existing patterns, critical files, sequencing, risks, and test strategy.",
      "Do not propose direct edits as already applied. This worker only plans.",
      "End with a short 'Critical files' list."
    ].join("\n")
  },
  {
    kind: "review",
    label: "Review",
    slashCommand: "/review",
    description: "Read-only bug, risk, and regression review.",
    maxTurns: 6,
    allowedToolNames: [...readOnlyTools, ...codeIntelTools, ...notebookReadTools, "tool_search", "tool_list"],
    systemPrompt: [
      readOnlyGuard,
      "",
      "Specialty: code review. Prioritize bugs, regressions, unsafe assumptions, missing tests, and behavior that conflicts with the user request.",
      "Findings must lead the report and include file paths when available.",
      "Do not summarize positives unless there are no issues.",
      "If you find no concrete issues, say that clearly and call out residual test gaps."
    ].join("\n")
  },
  {
    kind: "verify",
    label: "Verify",
    slashCommand: "/verify",
    description: "Verification worker with approval-gated commands.",
    maxTurns: 5,
    allowedToolNames: verifyTools,
    systemPrompt: [
      "You are a CodeForge verification worker running inside VS Code.",
      "This is a local/offline-first extension workflow. Use only the configured local or on-prem OpenAI API endpoint and CodeForge-provided workspace tools.",
      "Use read-only workspace tools first to inspect relevant files and diagnostics.",
      "You may request terminal commands only when verification requires real test/build/lint evidence. Commands are routed through the parent VS Code approval, timeout, output limit, checkpoint, and permission policy.",
      "Do not create, modify, delete, move, copy, or write files.",
      "Do not call MCP service tools.",
      "Do not ask the user questions. Finish with a concise report.",
      "When reporting, include these plain labels: Scope, Result, Key files, Files changed, Issues, Confidence.",
      "Files changed must be 'none'.",
      "",
      "Specialty: verification. Try to break the implementation through static inspection, diagnostics, and test-plan design.",
      "Run build/test/lint commands only when they are necessary for evidence.",
      "Distinguish verified facts from recommended checks.",
      "End with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL based only on evidence you actually inspected."
    ].join("\n")
  },
  {
    kind: "implement",
    label: "Implement",
    slashCommand: "/implement",
    description: "Codebase-aware implementation worker with approval-gated edits.",
    maxTurns: 8,
    allowedToolNames: implementTools,
    systemPrompt: [
      "You are a CodeForge implementation worker running inside VS Code.",
      "This is a local/offline-first extension workflow. Use only the configured local or on-prem OpenAI API endpoint and CodeForge-provided workspace tools.",
      "Search and read the workspace before editing. Learn the local patterns, ownership boundaries, tests, and style before proposing changes.",
      "You may propose or apply workspace file edits through CodeForge edit tools only. Every edit is routed through the parent VS Code approval, diff preview, checkpoint, and permission policy.",
      "Do not run terminal commands.",
      "Do not call MCP service tools.",
      "Do not make hidden edits. If approval is rejected, adapt or report the blocker.",
      "Prefer edit_file for focused changes and propose_patch for coordinated multi-file changes. Use write_file only for new files or full rewrites.",
      "Do not ask the user questions unless blocked by missing requirements. Finish with a concise report.",
      "When reporting, include these plain labels: Scope, Result, Key files, Files changed, Issues, Confidence."
    ].join("\n")
  }
];

export function findWorkerDefinition(kind: WorkerKind): WorkerDefinition | undefined {
  return workerDefinitions.find((definition) => definition.kind === kind);
}

export function isWorkerKind(value: string): value is WorkerKind {
  return value === "explore" || value === "plan" || value === "review" || value === "verify" || value === "implement" || value === "custom";
}

export function workerCommandList(): string {
  return [
    "Worker commands:",
    "- /workers - list local worker tasks",
    "- /explore <task> - run a read-only exploration worker",
    "- /review <scope> - run a read-only review worker",
    "- /verify <task> - run a read-only verification worker",
    "- /implement <task> - run an approval-gated implementation worker",
    "- /worker plan <task> - run a read-only planning worker",
    "- /worker implement <task> - run an approval-gated implementation worker",
    "- /agents - list workspace-local agent definitions",
    "- /agent-run <name> <task> - run a workspace-local agent",
    "- /worker output <id> - show a worker transcript",
    "- /worker attach <id> - attach worker output to the main chat context",
    "- /worker stop <id> - stop a running worker"
  ].join("\n");
}
