import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import {
  configuredMcpServerStatuses,
  inspectConfiguredMcpServers,
  McpResourceSummary,
  McpServerInspection,
  McpServerStatus,
  McpToolSummary,
  readConfiguredMcpResource
} from "../core/mcpClient";
import { ContextItem } from "../core/types";
import type {
  AgentMcpInspectionSummary,
  AgentMcpResourceContextSummary,
  AgentMcpResourceSummary,
  AgentMcpServerStatusSummary,
  AgentMcpToolSummary,
  AgentUiEvent
} from "./agentUiTypes";
import { errorMessage } from "./toolText";

export interface McpCoordinatorDeps {
  readonly config: CodeForgeConfigService;
  emit(event: AgentUiEvent): void;
  publishState(): Promise<void>;
  emitContextUsage(): void;
  currentSignal(): AbortSignal | undefined;
}

// Owns the user-facing MCP surface: server status/inspection, and the resources explicitly attached to
// chat context. The model-facing mcp_call_tool / tool-schema search stay with tool execution; this
// coordinator holds only the management commands and the attached-resource context items.
export class McpCoordinator {
  private contextItems: ContextItem[] = [];

  constructor(private readonly deps: McpCoordinatorDeps) {}

  getContextItems(): readonly ContextItem[] {
    return this.contextItems;
  }

  reset(): void {
    this.contextItems = [];
  }

  serverStatusSummaries(): readonly AgentMcpServerStatusSummary[] {
    return configuredMcpServerStatuses(this.deps.config.getMcpServers(), this.deps.config.getNetworkPolicy()).map(toAgentMcpServerStatusSummary);
  }

  resourceSummaries(): readonly AgentMcpResourceContextSummary[] {
    return this.contextItems.map(toAgentMcpResourceContextSummary);
  }

  async inspectServers(serverId?: string, servers = this.deps.config.getMcpServers()): Promise<void> {
    const inspections = await inspectConfiguredMcpServers(
      servers,
      this.deps.config.getNetworkPolicy(),
      serverId,
      this.deps.currentSignal()
    );
    this.deps.emit({ type: "mcpProbe", inspections: inspections.map(toAgentMcpInspectionSummary) });
    await this.deps.publishState();
  }

  async handleCommand(rest: string): Promise<void> {
    const [subcommandRaw, serverIdRaw, ...tail] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "status";
    const serverId = serverIdRaw || undefined;
    switch (subcommand) {
      case "status":
      case "list":
      case "servers":
        this.showServers();
        return;
      case "tools":
        await this.showInspection("tools", serverId);
        return;
      case "resources":
        await this.showInspection("resources", serverId);
        return;
      case "attach":
      case "select": {
        const uri = tail.join(" ").trim();
        if (!serverId || !uri) {
          this.deps.emit({ type: "message", role: "system", text: "Usage: /mcp attach <server-id> <resource-uri>" });
          return;
        }
        await this.attachResource(serverId, uri);
        return;
      }
      case "detach":
      case "remove": {
        const uri = tail.join(" ").trim();
        if (!serverId) {
          this.deps.emit({ type: "message", role: "system", text: "Usage: /mcp detach <server-id> <resource-uri|all>" });
          return;
        }
        this.detachResource(serverId, uri || "all");
        return;
      }
      case "clear":
        this.contextItems = [];
        this.deps.emit({ type: "message", role: "system", text: "Cleared attached MCP resources from this chat context." });
        this.deps.emitContextUsage();
        await this.deps.publishState();
        return;
      default:
        this.deps.emit({ type: "message", role: "system", text: "Usage: /mcp status, /mcp tools [server-id], /mcp resources [server-id], /mcp attach <server-id> <resource-uri>, /mcp detach <server-id> <resource-uri|all>, or /mcp clear." });
    }
  }

  private showServers(): void {
    const statuses = configuredMcpServerStatuses(this.deps.config.getMcpServers(), this.deps.config.getNetworkPolicy());
    if (statuses.length === 0) {
      this.deps.emit({ type: "message", role: "system", text: "No MCP servers are configured. Add explicit servers in CodeForge settings before using MCP tools." });
      return;
    }

    const lines = statuses.map((server) => {
      const state = server.enabled ? server.valid ? "ready" : "blocked" : "disabled";
      const target = server.target ? ` ${server.target}` : "";
      const reason = server.reason ? ` - ${server.reason}` : "";
      return `- ${server.id} (${server.label}) ${server.transport}${target}: ${state}${reason}`;
    });
    this.deps.emit({ type: "message", role: "system", text: `Configured MCP servers:\n${lines.join("\n")}` });
  }

  private async showInspection(kind: "tools" | "resources", serverId: string | undefined): Promise<void> {
    const inspections = await inspectConfiguredMcpServers(
      this.deps.config.getMcpServers(),
      this.deps.config.getNetworkPolicy(),
      serverId,
      this.deps.currentSignal()
    );
    this.deps.emit({ type: "mcpProbe", inspections: inspections.map(toAgentMcpInspectionSummary) });
    this.deps.emit({ type: "message", role: "system", text: formatMcpInspectionReport(inspections, kind) });
    await this.deps.publishState();
  }

  async attachResource(serverId: string, uri: string, servers = this.deps.config.getMcpServers()): Promise<void> {
    try {
      const resource = await readConfiguredMcpResource(
        servers,
        this.deps.config.getNetworkPolicy(),
        serverId,
        uri,
        this.deps.currentSignal()
      );
      const label = `${resource.serverId}:${resource.uri}`;
      this.contextItems = [
        ...this.contextItems.filter((item) => item.label !== label),
        {
          kind: "mcpResource",
          label,
          content: resource.content
        }
      ];
      this.deps.emit({ type: "message", role: "system", text: `Attached MCP resource ${label} to this chat context.` });
      this.deps.emitContextUsage();
      await this.deps.publishState();
    } catch (error) {
      this.deps.emit({ type: "error", text: errorMessage(error) });
    }
  }

  detachResource(serverId: string, uri: string): void {
    const before = this.contextItems.length;
    this.contextItems = uri === "all"
      ? this.contextItems.filter((item) => !item.label.startsWith(`${serverId}:`))
      : this.contextItems.filter((item) => item.label !== `${serverId}:${uri}`);
    const removed = before - this.contextItems.length;
    this.deps.emit({
      type: "message",
      role: "system",
      text: removed > 0 ? `Detached ${removed} MCP resource(s).` : "No matching MCP resource was attached."
    });
    this.deps.emitContextUsage();
    void this.deps.publishState();
  }

  async listResourcesForTool(serverId: string | undefined): Promise<string> {
    const inspections = await inspectConfiguredMcpServers(
      this.deps.config.getMcpServers(),
      this.deps.config.getNetworkPolicy(),
      serverId,
      this.deps.currentSignal()
    );
    return `mcp_list_resources${serverId ? ` ${serverId}` : ""}\n\n${formatMcpInspectionReport(inspections, "resources")}`;
  }
}

function toAgentMcpServerStatusSummary(status: McpServerStatus): AgentMcpServerStatusSummary {
  return {
    id: status.id,
    label: status.label,
    enabled: status.enabled,
    transport: status.transport,
    target: status.target,
    valid: status.valid,
    reason: status.reason
  };
}

function toAgentMcpInspectionSummary(inspection: McpServerInspection): AgentMcpInspectionSummary {
  return {
    server: toAgentMcpServerStatusSummary(inspection.status),
    tools: inspection.tools.map(toAgentMcpToolSummary),
    resources: inspection.resources.map(toAgentMcpResourceSummary),
    error: inspection.error
  };
}

function toAgentMcpToolSummary(tool: McpToolSummary): AgentMcpToolSummary {
  return { name: tool.name, description: tool.description };
}

function toAgentMcpResourceSummary(resource: McpResourceSummary): AgentMcpResourceSummary {
  return { uri: resource.uri, name: resource.name, description: resource.description, mimeType: resource.mimeType };
}

function toAgentMcpResourceContextSummary(item: ContextItem): AgentMcpResourceContextSummary {
  const [serverId, ...uriParts] = item.label.split(":");
  return {
    serverId,
    uri: uriParts.join(":"),
    label: item.label,
    bytes: Buffer.byteLength(item.content, "utf8")
  };
}

function formatMcpInspectionReport(inspections: readonly McpServerInspection[], kind: "tools" | "resources"): string {
  if (inspections.length === 0) {
    return "No MCP servers are configured.";
  }

  const lines: string[] = [];
  for (const inspection of inspections) {
    const state = inspection.status.enabled ? inspection.status.valid ? "ready" : "blocked" : "disabled";
    lines.push(`${inspection.status.id} (${inspection.status.label}) ${inspection.status.transport}: ${state}`);
    if (inspection.error) {
      lines.push(`  Error: ${inspection.error}`);
      continue;
    }
    if (kind === "tools") {
      if (inspection.tools.length === 0) {
        lines.push("  No tools reported.");
      } else {
        for (const tool of inspection.tools) {
          lines.push(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
        }
      }
    } else if (inspection.resources.length === 0) {
      lines.push("  No resources reported.");
    } else {
      for (const resource of inspection.resources) {
        const details = [resource.name, resource.mimeType].filter(Boolean).join(" | ");
        lines.push(`  - ${resource.uri}${details ? ` (${details})` : ""}`);
      }
      lines.push("  Use /mcp attach <server-id> <resource-uri> to add a resource to chat context.");
    }
  }
  return `MCP ${kind}:\n${lines.join("\n")}`;
}
