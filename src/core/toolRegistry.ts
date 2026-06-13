import {
  AgentAction,
  AskUserQuestionAction,
  EditFileAction,
  McpCallToolAction,
  NotebookEditCellAction,
  ProposePatchAction,
  RunCommandAction,
  ToolDefinition,
  WriteFileAction
} from "./types";
import type { ToolValidationResult } from "./toolValidation";
import { readTools } from "./tools/readTools";
import { workerTools } from "./tools/workerTools";
import { interactionTools } from "./tools/interactionTools";
import { taskTools } from "./tools/taskTools";
import { codeIntelTools } from "./tools/codeIntelTools";
import { mcpTools } from "./tools/mcpTools";
import { notebookTools } from "./tools/notebookTools";
import { memoryTools } from "./tools/memoryTools";
import { editTools } from "./tools/editTools";
import { commandTools } from "./tools/commandTools";

export type ToolRisk = "read" | "search" | "automation" | "question" | "memory" | "state" | "service" | "edit" | "command";

// The validation primitives, the pure action-classification predicates, and the per-domain tool tables
// now live in their own modules. These re-exports keep existing importers getting them from toolRegistry.
export type { ToolValidationResult };
export { validateWorkspacePath, validateWorkspaceGlob } from "./toolValidation";
export {
  isReadOnlyAction,
  isLocalReadOnlyAction,
  isInternalAutomationAction,
  isInternalStateAction,
  isInternalReadAction
} from "./toolClassification";

export interface CodeForgeTool {
  readonly name: AgentAction["type"];
  readonly description: string;
  readonly searchHint?: string;
  readonly parameters: Record<string, unknown>;
  readonly risk: ToolRisk;
  readonly concurrencySafe: boolean;
  readonly requiresApproval: boolean;
  parse(input: Record<string, unknown>): AgentAction | undefined;
  validate(action: AgentAction): ToolValidationResult;
  summarize(action: AgentAction): string;
}

export interface ToolInvocation {
  readonly id: string;
  readonly action: AgentAction;
  readonly source: "native" | "json";
  readonly toolCallId?: string;
}

// The tool table is composed from per-domain modules (src/core/tools/*). Each exports a
// readonly CodeForgeTool[]; the order here is preserved for the few consumers that map over it.
export const codeForgeTools: readonly CodeForgeTool[] = [
  ...readTools,
  ...workerTools,
  ...interactionTools,
  ...taskTools,
  ...codeIntelTools,
  ...mcpTools,
  ...notebookTools,
  ...memoryTools,
  ...editTools,
  ...commandTools
];

export const toolDefinitions: readonly ToolDefinition[] = codeForgeTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
}));

export function findTool(name: string): CodeForgeTool | undefined {
  return codeForgeTools.find((tool) => tool.name === name);
}

export function parseAction(name: string, input: Record<string, unknown>): AgentAction | undefined {
  return findTool(name)?.parse(input);
}

export function validateAction(action: AgentAction): ToolValidationResult {
  return findTool(action.type)?.validate(action) ?? { ok: false, message: `Unknown tool: ${action.type}` };
}

export function isConcurrencySafeAction(action: AgentAction): boolean {
  return Boolean(findTool(action.type)?.concurrencySafe);
}

export function isApprovalAction(action: AgentAction): action is AskUserQuestionAction | ProposePatchAction | WriteFileAction | EditFileAction | NotebookEditCellAction | RunCommandAction | McpCallToolAction {
  const tool = findTool(action.type);
  return Boolean(tool?.requiresApproval);
}

export function toolSummary(action: AgentAction): string {
  return findTool(action.type)?.summarize(action) ?? action.type;
}
