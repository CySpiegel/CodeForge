import {
  AgentAction,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionPolicy,
  PermissionRule,
  PermissionRuleKind
} from "./types";
import { classifyShellCommand } from "./shellSemantics";
import { findTool, toolSummary } from "./toolRegistry";
import { parseUnifiedDiff, targetPath } from "./unifiedDiff";

export const defaultPermissionPolicy: PermissionPolicy = {
  mode: "default",
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
    mode: isPermissionMode(policy.mode) ? policy.mode : "default",
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
    case "default":
      return "Default";
    case "review":
      return "Review";
    case "acceptEdits":
      return "Accept edits";
    case "readOnly":
      return "Read only";
    case "workspaceTrusted":
      return "Workspace trusted";
  }
}

interface PermissionContext {
  readonly toolName: AgentAction["type"];
  readonly paths: readonly string[];
  readonly command?: string;
}

function buildPermissionContext(action: AgentAction): PermissionContext {
  return {
    toolName: action.type,
    paths: actionPaths(action),
    command: action.type === "run_command" ? action.command : undefined
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
      return false;
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
  if (mode === "readOnly" && isSideEffectAction(action)) {
    return {
      behavior: "deny",
      source: "mode",
      reason: "Current permission mode is read only."
    };
  }

  if (mode === "review" && isSideEffectAction(action)) {
    return {
      behavior: "ask",
      source: "mode",
      reason: "Current permission mode requires approval for every edit and command."
    };
  }

  if (mode === "workspaceTrusted" && action.type === "run_command") {
    const semantics = classifyShellCommand(action.command);
    if (semantics.isDestructive) {
      return {
        behavior: "ask",
        source: "mode",
        reason: "Workspace trusted mode still requires approval for destructive commands."
      };
    }
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

  if (mode === "acceptEdits" && (action.type === "propose_patch" || action.type === "write_file" || action.type === "edit_file")) {
    return {
      behavior: "allow",
      source: "mode",
      reason: "Current permission mode allows proposed edits after diff validation."
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
  return action.type === "propose_patch" || action.type === "write_file" || action.type === "edit_file" || action.type === "run_command";
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

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "review" || value === "acceptEdits" || value === "readOnly" || value === "workspaceTrusted";
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
