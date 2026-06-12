import { toolSummary } from "../core/toolRegistry";
import { AgentAction, PermissionDecision } from "../core/types";
import type { AgentAuditEntry, AgentInspectorEntry, AgentInspectorSummary, AgentUiEvent } from "./agentUiTypes";

export interface InspectorLogDeps {
  emit(event: AgentUiEvent): void;
}

// Most-recent-first ring buffers are capped at this many entries each.
const inspectorRingLimit = 200;

// Owns the run-inspector and permission-audit ring buffers and the `inspector` UI event they back.
// The controller and sibling modules (ModelResolver, LearningCoordinator, SlashCommandRouter) push
// events through record()/recordAudit() and read snapshots via summary(); this module holds the only
// mutable copies, so the controller no longer carries telemetry state.
export class InspectorLog {
  private inspectorEntries: AgentInspectorEntry[] = [];
  private auditEntries: AgentAuditEntry[] = [];

  constructor(private readonly deps: InspectorLogDeps) {}

  record(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void {
    const entry: AgentInspectorEntry = {
      id: `inspect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      level,
      category,
      summary,
      detail
    };
    this.inspectorEntries = [entry, ...this.inspectorEntries].slice(0, inspectorRingLimit);
    this.emit();
  }

  recordAudit(action: AgentAction, decision: PermissionDecision, outcome: AgentAuditEntry["outcome"]): void {
    const entry: AgentAuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      action: action.type,
      behavior: decision.behavior,
      source: decision.source,
      reason: decision.reason,
      outcome,
      summary: toolSummary(action)
    };
    this.auditEntries = [entry, ...this.auditEntries].slice(0, inspectorRingLimit);
    this.emit();
  }

  emit(): void {
    this.deps.emit({ type: "inspector", inspector: this.summary() });
  }

  summary(): AgentInspectorSummary {
    return {
      entries: this.inspectorEntries,
      audit: this.auditEntries
    };
  }

  inspectorLog(): readonly AgentInspectorEntry[] {
    return this.inspectorEntries;
  }

  auditLog(): readonly AgentAuditEntry[] {
    return this.auditEntries;
  }

  reset(): void {
    this.inspectorEntries = [];
    this.auditEntries = [];
  }
}
