import { AgentAction, McpServerConfig, PermissionDecision } from "../core/types";
import { classifyShellCommand } from "../core/shellSemantics";
import { formatBytes } from "../core/contextUsage";
import { WorkerSummary } from "../core/workerTypes";

export interface ApprovalMetadata {
  readonly detail?: string;
  readonly risk?: string;
}

// Narrow config surface the formatter needs — satisfied structurally by the ConfigPort the controller holds.
export interface ApprovalMetadataConfig {
  getMcpServers(): readonly McpServerConfig[];
  getCommandTimeoutSeconds(): number;
  getCommandOutputLimitBytes(): number;
}

// Builds the human-readable risk + detail shown on an approval card for a pending action. This is pure
// display formatting (per action type), kept out of the run engine; the controller delegates to it.
export function buildApprovalMetadata(action: AgentAction, decision: PermissionDecision, config: ApprovalMetadataConfig): ApprovalMetadata {
  if (action.type === "mcp_call_tool") {
    const server = config.getMcpServers().find((item) => item.id === action.serverId);
    return {
      risk: "configured MCP service tool",
      detail: [
        `Server: ${action.serverId}${server ? ` (${server.label})` : ""}`,
        `Transport: ${server?.transport ?? "unknown"}`,
        `Tool: ${action.toolName}`,
        `Permission: ${decision.reason}`
      ].join("\n")
    };
  }

  if (action.type === "ask_user_question") {
    return {
      risk: "requires user input",
      detail: action.questions.map((question, index) => {
        const options = question.options.map((option) => `  - ${option.label}: ${option.description}`).join("\n");
        return `${index + 1}. ${question.question}\n${options}`;
      }).join("\n\n")
    };
  }

  if (action.type === "notebook_edit_cell") {
    return {
      risk: "workspace notebook edit",
      detail: [
        `Path: ${action.path}`,
        `Cell: ${action.index}`,
        action.kind ? `Kind: ${action.kind}` : undefined,
        action.language ? `Language: ${action.language}` : undefined,
        "",
        action.content
      ].filter((line): line is string => line !== undefined).join("\n")
    };
  }

  if (action.type !== "run_command") {
    return {};
  }

  const semantics = classifyShellCommand(action.command);
  const timeout = config.getCommandTimeoutSeconds();
  const outputLimit = config.getCommandOutputLimitBytes();
  return {
    risk: [
      semantics.summary,
      semantics.usesNetwork ? "network-capable" : undefined,
      semantics.usesShellExpansion ? "dynamic shell expansion" : undefined
    ].filter((item): item is string => Boolean(item)).join("; "),
    detail: [
      `Command: ${action.command}`,
      `CWD: ${action.cwd?.trim() || "."}`,
      `Timeout: ${timeout}s`,
      `Output limit: ${formatBytes(outputLimit)} per stream`,
      `Permission: ${decision.reason}`,
      `Risk: ${semantics.summary}`,
      semantics.commandNames.length > 0 ? `Detected commands: ${semantics.commandNames.join(", ")}` : undefined,
      semantics.usesNetwork ? "Warning: command can use network-capable tools." : undefined,
      semantics.usesShellExpansion ? "Warning: command uses dynamic shell expansion." : undefined
    ].filter((line): line is string => Boolean(line)).join("\n")
  };
}

// Same, wrapped with the requesting worker's identity for approvals raised from a sub-agent.
export function buildWorkerApprovalMetadata(worker: WorkerSummary, action: AgentAction, decision: PermissionDecision, config: ApprovalMetadataConfig): ApprovalMetadata & { readonly origin: "worker" } {
  const base = buildApprovalMetadata(action, decision, config);
  return {
    origin: "worker",
    risk: base.risk,
    detail: [
      `Requested by worker: ${worker.label} (${worker.id})`,
      `Worker task: ${worker.prompt}`,
      base.detail
    ].filter((line): line is string => Boolean(line)).join("\n")
  };
}
