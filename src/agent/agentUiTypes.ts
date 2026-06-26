// UI contract types shared between the AgentController and the webview bridge. Kept in their own
// module so collaborators can depend on the event/state shapes without importing the controller.
import { ContextUsage } from "../core/contextUsage";
import { ApprovalRequest, PermissionDecision } from "../core/types";
import { WorkerSummary } from "../core/workerTypes";

export type AgentUiEvent =
  | { readonly type: "sessionReset" }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "runStatus"; readonly text: string }
  | { readonly type: "message"; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly type: "assistantDelta"; readonly text: string }
  | { readonly type: "assistantReasoningDelta"; readonly text: string }
  | { readonly type: "toolResult"; readonly text: string }
  | { readonly type: "toolUse"; readonly toolUse: AgentToolUse }
  | { readonly type: "sessions"; readonly sessions: readonly AgentSessionSummary[] }
  | { readonly type: "state"; readonly state: AgentUiState }
  | { readonly type: "models"; readonly models: readonly string[]; readonly modelInfo: readonly AgentModelSummary[]; readonly selectedModel: string; readonly backendLabel?: string; readonly error?: string }
  | { readonly type: "mcpProbe"; readonly inspections: readonly AgentMcpInspectionSummary[] }
  | { readonly type: "contextUsage"; readonly usage: ContextUsage }
  | { readonly type: "workers"; readonly workers: readonly AgentWorkerSummary[] }
  | { readonly type: "inspector"; readonly inspector: AgentInspectorSummary }
  | { readonly type: "openSettings" }
  | { readonly type: "approvalRequested"; readonly approval: ApprovalRequest }
  | { readonly type: "approvalResolved"; readonly id: string; readonly accepted: boolean; readonly text: string }
  | { readonly type: "error"; readonly text: string }
  | { readonly type: "runComplete"; readonly reason: "idle" | "awaitingApproval" };

export interface AgentUiState {
  readonly profiles: readonly AgentProfileSummary[];
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeBaseUrl: string;
  readonly selectedModel: string;
  readonly selectedModelInfo?: AgentModelSummary;
  readonly activeBackendLabel?: string;
  readonly models: readonly string[];
  readonly modelInfo: readonly AgentModelSummary[];
  readonly contextUsage: ContextUsage;
  readonly localCommands: readonly AgentLocalCommandSummary[];
  readonly mcpServers: readonly AgentMcpServerStatusSummary[];
  readonly mcpContext: readonly AgentMcpResourceContextSummary[];
  readonly workers: readonly AgentWorkerSummary[];
  readonly activeContext: AgentActiveContextSummary;
  readonly memories: readonly AgentMemorySummary[];
  readonly capabilityCache: readonly AgentCapabilitySummary[];
  readonly inspector: AgentInspectorSummary;
  readonly settings: AgentSettingsSummary;
}

export interface AgentProfileSummary {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
}

export interface AgentModelSummary {
  readonly id: string;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly supportsReasoning?: boolean;
}

export interface AgentLocalCommandSummary {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly path: string;
}

export interface AgentMcpServerStatusSummary {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: string;
  readonly target: string;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface AgentMcpToolSummary {
  readonly name: string;
  readonly description?: string;
}

export interface AgentMcpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface AgentMcpInspectionSummary {
  readonly server: AgentMcpServerStatusSummary;
  readonly tools: readonly AgentMcpToolSummary[];
  readonly resources: readonly AgentMcpResourceSummary[];
  readonly error?: string;
}

export interface AgentMcpResourceContextSummary {
  readonly serverId: string;
  readonly uri: string;
  readonly label: string;
  readonly bytes: number;
}

export interface AgentSettingsSummary {
  readonly agentMode: string;
  readonly allowlist: readonly string[];
  readonly maxFiles: number;
  readonly maxTokens?: number;
  readonly maxBytes: number;
  readonly commandTimeoutSeconds: number;
  readonly modelIdleTimeoutSeconds: number;
  readonly streamCompletionGraceSeconds: number;
  readonly maxInvalidToolCallRetries: number;
  readonly commandOutputLimitBytes: number;
  readonly permissionMode: string;
  readonly permissionRules: readonly unknown[];
  readonly mcpServers: readonly unknown[];
}

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "approval";
  readonly readOnly: boolean;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pendingApprovalCount: number;
}

export type AgentWorkerSummary = WorkerSummary;

export interface AgentActiveContextSummary {
  readonly activeFile?: string;
  readonly workspaceReady: boolean;
  readonly pinnedFiles: readonly string[];
}

export interface AgentMemorySummary {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly scope: string;
  readonly namespace?: string;
}

export interface AgentCapabilitySummary {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly backendLabel?: string;
  readonly nativeToolCalls: boolean;
  readonly streaming: boolean;
  readonly modelListing: boolean;
  readonly contextLength?: number;
  readonly supportsReasoning?: boolean;
  readonly checkedAt: number;
}

export interface AgentInspectorSummary {
  readonly entries: readonly AgentInspectorEntry[];
  readonly audit: readonly AgentAuditEntry[];
}

export interface AgentInspectorEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly level: "info" | "warn" | "error";
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface AgentAuditEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly action: string;
  readonly behavior: PermissionDecision["behavior"];
  readonly source: PermissionDecision["source"];
  readonly reason: string;
  readonly outcome: "allowed" | "approval" | "denied" | "accepted" | "rejected" | "failed";
  readonly summary: string;
}
