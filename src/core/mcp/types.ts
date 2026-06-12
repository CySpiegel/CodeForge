import { McpServerConfig } from "../types";

// All MCP client types in one place so the facade (mcpClient.ts), the protocol leaves (jsonRpc,
// responseFormat), and the transports can share them without import cycles. The facade re-exports the
// public ones (McpServerStatus/McpToolSummary/McpResourceSummary/McpServerInspection/
// McpResourceReadResult) so existing `from "../core/mcpClient"` importers are unaffected.

export interface JsonRpcResponse {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface McpTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse>;
  notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface McpServerStatus {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: McpServerConfig["transport"];
  readonly target: string;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpServerInspection {
  readonly status: McpServerStatus;
  readonly serverInfo?: unknown;
  readonly tools: readonly McpToolSummary[];
  readonly resources: readonly McpResourceSummary[];
  readonly error?: string;
}

export interface McpResourceReadResult {
  readonly serverId: string;
  readonly uri: string;
  readonly label: string;
  readonly content: string;
}
