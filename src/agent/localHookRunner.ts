import { TerminalRunner } from "../adapters/terminalRunner";
import { loadLocalHooks, LocalHook, localHookMatches } from "../core/localExtensions";
import { evaluateActionPermission } from "../core/permissions";
import { validateAction } from "../core/toolRegistry";
import { AgentAction, PermissionPolicy, WorkspacePort } from "../core/types";
import type { AgentUiEvent } from "./agentUiTypes";
import { formatCommandResult, hookFailureStatus } from "./commandResultText";

export interface LocalHookRunnerDeps {
  readonly workspace: WorkspacePort;
  readonly terminal: TerminalRunner;
  getPermissionPolicy(): PermissionPolicy;
  getCommandTimeoutSeconds(): number;
  getCommandOutputLimitBytes(): number;
  signal(): AbortSignal | undefined;
  emit(event: AgentUiEvent): void;
}

// Runs workspace-local pre/post/failure shell hooks for a tool event: discover matching hooks, validate
// + permission-gate each command, stream its output, and throw on failure so the run loop surfaces it.
export class LocalHookRunner {
  constructor(private readonly deps: LocalHookRunnerDeps) {}

  async run(event: LocalHook["event"], action: AgentAction): Promise<void> {
    const hooks = (await loadLocalHooks(this.deps.workspace, this.deps.signal()))
      .filter((hook) => localHookMatches(hook, event, action));
    for (const hook of hooks) {
      await this.runOne(hook, event, action);
    }
  }

  private async runOne(hook: LocalHook, event: LocalHook["event"], action: AgentAction): Promise<void> {
    const validation = validateAction(hook.command);
    if (!validation.ok) {
      throw new Error(`Local hook ${hook.name} is invalid: ${validation.message ?? "Command validation failed."}`);
    }

    const decision = evaluateActionPermission(hook.command, this.deps.getPermissionPolicy());
    if (decision.behavior !== "allow") {
      throw new Error(`Local hook ${hook.name} cannot run because it is not explicitly allowed by the permission policy. ${decision.reason}`);
    }

    this.deps.emit({
      type: "status",
      text: `Running local ${event} hook ${hook.name} for ${action.type}.`
    });
    const result = await this.deps.terminal.run(hook.command, {
      timeoutSeconds: hook.timeoutSeconds ?? this.deps.getCommandTimeoutSeconds(),
      outputLimitBytes: Math.min(this.deps.getCommandOutputLimitBytes(), 200000),
      signal: this.deps.signal()
    }, (stream, text) => {
      this.deps.emit({ type: "toolResult", text: `${event} hook ${hook.name} ${stream}: ${text}` });
    });
    const formatted = [
      `local_hook ${hook.name}`,
      "",
      `Event: ${event}`,
      `Tool: ${action.type}`,
      `Path: ${hook.path}`,
      hook.description ? `Description: ${hook.description}` : undefined,
      formatCommandResult(hook.command, result)
    ].filter((line): line is string => Boolean(line)).join("\n");
    this.deps.emit({ type: "toolResult", text: formatted });

    if (result.timedOut || result.cancelled || result.exitCode !== 0) {
      throw new Error(`Local hook ${hook.name} failed for ${action.type}. ${hookFailureStatus(result)}`);
    }
  }
}
