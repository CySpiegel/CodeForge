import { WorkerDefinition, WorkerKind } from "./workerTypes";

const readOnlyTools = ["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics"] as const;

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
    allowedToolNames: readOnlyTools,
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
    allowedToolNames: readOnlyTools,
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
    allowedToolNames: readOnlyTools,
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
    description: "Read-only verification planning and diagnostics.",
    maxTurns: 5,
    allowedToolNames: readOnlyTools,
    systemPrompt: [
      readOnlyGuard,
      "",
      "Specialty: verification. Try to break the implementation through static inspection, diagnostics, and test-plan design.",
      "Because this worker slice is read-only, do not run build or test commands. Instead, identify the exact commands a parent Agent-mode session should run for real verification.",
      "Distinguish verified facts from recommended checks.",
      "End with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL based only on evidence you actually inspected."
    ].join("\n")
  }
];

export function findWorkerDefinition(kind: WorkerKind): WorkerDefinition | undefined {
  return workerDefinitions.find((definition) => definition.kind === kind);
}

export function isWorkerKind(value: string): value is WorkerKind {
  return value === "explore" || value === "plan" || value === "review" || value === "verify";
}

export function workerCommandList(): string {
  return [
    "Worker commands:",
    "- /workers - list local worker tasks",
    "- /explore <task> - run a read-only exploration worker",
    "- /review <scope> - run a read-only review worker",
    "- /verify <task> - run a read-only verification worker",
    "- /worker plan <task> - run a read-only planning worker",
    "- /worker output <id> - show a worker transcript",
    "- /worker stop <id> - stop a running worker"
  ].join("\n");
}
