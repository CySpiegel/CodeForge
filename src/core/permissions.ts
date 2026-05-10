import {
  AgentAction,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionPolicy,
  PermissionRule,
  PermissionRuleKind
} from "./types";
import { findTool, toolSummary } from "./toolRegistry";
import { parseUnifiedDiff, targetPath } from "./unifiedDiff";

export const defaultPermissionPolicy: PermissionPolicy = {
  mode: "smart",
  rules: []
};

export function evaluateActionPermission(action: AgentAction, policy: PermissionPolicy): PermissionDecision {
  const normalizedPolicy = normalizePermissionPolicy(policy);
  const context = buildPermissionContext(action);

  const denyRule = findMatchingRule(normalizedPolicy.rules, "deny", context);
  if (denyRule) {
    return ruleDecision("deny", denyRule, action);
  }

  const modeConstraint = decisionFromModeConstraint(action, normalizedPolicy.mode);
  if (modeConstraint) {
    return modeConstraint;
  }

  const askRule = findMatchingRule(normalizedPolicy.rules, "ask", context);
  if (askRule) {
    return ruleDecision("ask", askRule, action);
  }

  const allowRule = findMatchingRule(normalizedPolicy.rules, "allow", context);
  if (allowRule) {
    return ruleDecision("allow", allowRule, action);
  }

  return defaultDecision(action, normalizedPolicy.mode);
}

export function normalizePermissionPolicy(policy: PermissionPolicy | undefined): PermissionPolicy {
  if (!policy) {
    return defaultPermissionPolicy;
  }
  return {
    mode: normalizePermissionMode(policy.mode),
    rules: policy.rules.filter(isValidRule).map((rule) => ({
      ...rule,
      pattern: rule.pattern.trim()
    }))
  };
}

export function parsePermissionRules(value: unknown, fallbackScope: PermissionRule["scope"]): readonly PermissionRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item): PermissionRule | undefined => {
    if (!isRecord(item)) {
      return undefined;
    }
    const kind = item.kind;
    const pattern = item.pattern;
    const behavior = item.behavior;
    const scope = item.scope;
    if (!isRuleKind(kind) || typeof pattern !== "string" || !isBehavior(behavior)) {
      return undefined;
    }
    return {
      kind,
      pattern,
      behavior,
      scope: isRuleScope(scope) ? scope : fallbackScope,
      description: typeof item.description === "string" ? item.description : undefined
    };
  }).filter((rule): rule is PermissionRule => Boolean(rule));
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "manual":
      return "Manual";
    case "smart":
      return "Smart";
    case "fullAuto":
      return "Full Auto";
  }
}

interface PermissionContext {
  readonly toolName: AgentAction["type"];
  readonly paths: readonly string[];
  readonly command?: string;
  readonly endpoint?: string;
}

function buildPermissionContext(action: AgentAction): PermissionContext {
  return {
    toolName: action.type,
    paths: actionPaths(action),
    command: action.type === "run_command" ? action.command : undefined,
    endpoint: action.type === "mcp_call_tool" ? action.serverId : undefined
  };
}

function actionPaths(action: AgentAction): readonly string[] {
  if (action.type === "list_files") {
    return action.pattern ? [action.pattern] : [];
  }
  if (action.type === "glob_files") {
    return [action.pattern];
  }
  if (action.type === "grep_text") {
    return action.include ? [action.include] : [];
  }
  if (action.type === "list_diagnostics") {
    return action.path ? [action.path] : [];
  }
  if (action.type === "read_file" || action.type === "write_file" || action.type === "edit_file") {
    return [action.path];
  }
  if (action.type === "run_command") {
    return action.cwd ? [action.cwd] : [];
  }
  if (action.type !== "propose_patch" && action.type !== "open_diff") {
    return [];
  }

  try {
    return parseUnifiedDiff(action.patch)
      .map(targetPath)
      .filter((path) => path !== "/dev/null");
  } catch {
    return [];
  }
}

function findMatchingRule(
  rules: readonly PermissionRule[],
  behavior: PermissionBehavior,
  context: PermissionContext
): PermissionRule | undefined {
  return rules.find((rule) => rule.behavior === behavior && ruleMatchesContext(rule, context));
}

function ruleMatchesContext(rule: PermissionRule, context: PermissionContext): boolean {
  switch (rule.kind) {
    case "tool":
      return wildcardMatch(rule.pattern, context.toolName);
    case "path":
      return context.paths.some((path) => wildcardMatch(rule.pattern, normalizePath(path)));
    case "command":
      return Boolean(context.command && commandPatternMatches(rule.pattern, context.command));
    case "endpoint":
      return Boolean(context.endpoint && wildcardMatch(rule.pattern, context.endpoint));
  }
}

function commandPatternMatches(pattern: string, command: string): boolean {
  const normalizedPattern = pattern.trim();
  const normalizedCommand = command.trim();
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.includes("*")) {
    return wildcardMatch(normalizedPattern, normalizedCommand);
  }
  return normalizedCommand === normalizedPattern || normalizedCommand.startsWith(`${normalizedPattern} `);
}

function decisionFromModeConstraint(action: AgentAction, mode: PermissionMode): PermissionDecision | undefined {
  if (mode === "manual" && isSideEffectAction(action)) {
    return {
      behavior: "ask",
      source: "mode",
      reason: "Manual approval mode asks before edits and local commands."
    };
  }

  if (mode === "smart" && action.type === "run_command") {
    return {
      behavior: "ask",
      source: "mode",
      reason: "Smart approval mode asks before terminal commands."
    };
  }

  if (mode === "smart" && action.type === "mcp_call_tool") {
    return {
      behavior: "ask",
      source: "mode",
      reason: "Smart approval mode asks before MCP service tool calls."
    };
  }

  if (mode === "smart" && isRiskyEditAction(action)) {
    return {
      behavior: "ask",
      source: "mode",
      reason: "Smart approval mode asks before large edits, file creation, or file deletion."
    };
  }

  return undefined;
}

function defaultDecision(action: AgentAction, mode: PermissionMode): PermissionDecision {
  if (action.type === "list_files" || action.type === "glob_files" || action.type === "read_file" || action.type === "search_text" || action.type === "grep_text" || action.type === "list_diagnostics" || action.type === "open_diff") {
    return {
      behavior: "allow",
      source: "default",
      reason: `${toolSummary(action)} does not modify the workspace.`
    };
  }

  if (mode === "smart" && isSmallEditAction(action)) {
    return {
      behavior: "allow",
      source: "mode",
      reason: "Smart approval mode allows small workspace edits."
    };
  }

  if (mode === "fullAuto" && isSideEffectAction(action)) {
    return {
      behavior: "allow",
      source: "mode",
      reason: "Full Auto approval mode allows edits and local commands without prompting."
    };
  }

  return {
    behavior: "ask",
    source: "default",
    reason: `${toolSummary(action)} requires approval before it can change files or run locally.`
  };
}

function ruleDecision(behavior: PermissionBehavior, rule: PermissionRule, action: AgentAction): PermissionDecision {
  return {
    behavior,
    source: "rule",
    reason: `${permissionRuleDescription(rule)} matched ${findTool(action.type)?.name ?? action.type}.`,
    rule
  };
}

function permissionRuleDescription(rule: PermissionRule): string {
  return `${rule.scope} ${rule.behavior} ${rule.kind} rule '${rule.pattern}'`;
}

function isSideEffectAction(action: AgentAction): boolean {
  return action.type === "propose_patch" || action.type === "write_file" || action.type === "edit_file" || action.type === "run_command" || action.type === "mcp_call_tool";
}

function isRiskyEditAction(action: AgentAction): boolean {
  if (action.type === "write_file") {
    return true;
  }
  if (action.type === "edit_file") {
    return Boolean(action.replaceAll) || changedLineCount(action.oldText, action.newText) > 80;
  }
  if (action.type !== "propose_patch") {
    return false;
  }

  try {
    const patches = parseUnifiedDiff(action.patch);
    if (patches.length > 3) {
      return true;
    }
    return patches.some((patch) => patch.oldPath === "/dev/null" || patch.newPath === "/dev/null" || patchChangedLines(patch) > 80);
  } catch {
    return true;
  }
}

function isSmallEditAction(action: AgentAction): boolean {
  return (action.type === "edit_file" || action.type === "propose_patch") && !isRiskyEditAction(action);
}

function changedLineCount(oldText: string, newText: string): number {
  return lineCount(oldText) + lineCount(newText);
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.replace(/\r\n/g, "\n").split("\n").length;
}

function patchChangedLines(patch: ReturnType<typeof parseUnifiedDiff>[number]): number {
  return patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.type === "add" || line.type === "remove").length, 0);
}

function wildcardMatch(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern === "*") {
    return true;
  }
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isValidRule(rule: PermissionRule): boolean {
  return isRuleKind(rule.kind) && isBehavior(rule.behavior) && isRuleScope(rule.scope) && rule.pattern.trim().length > 0;
}

function normalizePermissionMode(value: unknown): PermissionMode {
  switch (value) {
    case "manual":
    case "review":
    case "readOnly":
      return "manual";
    case "fullAuto":
    case "workspaceTrusted":
      return "fullAuto";
    case "smart":
    case "default":
    case "acceptEdits":
    default:
      return "smart";
  }
}

function isRuleKind(value: unknown): value is PermissionRuleKind {
  return value === "tool" || value === "path" || value === "command" || value === "endpoint";
}

function isBehavior(value: unknown): value is PermissionBehavior {
  return value === "allow" || value === "ask" || value === "deny";
}

function isRuleScope(value: unknown): value is PermissionRule["scope"] {
  return value === "session" || value === "workspace" || value === "user";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
