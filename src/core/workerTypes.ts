import { ToolDefinition } from "./types";

export type WorkerKind = "explore" | "plan" | "review" | "verify" | "implement" | "custom";
export type WorkerStatus = "running" | "completed" | "failed" | "stopped";
export type WorkerTranscriptRole = "system" | "user" | "assistant" | "tool" | "status";

export interface WorkerDefinition {
  readonly kind: WorkerKind;
  readonly label: string;
  readonly name?: string;
  readonly description: string;
  readonly invocationName: string;
  readonly maxTurns: number;
  readonly allowedToolNames: readonly ToolDefinition["name"][];
  readonly systemPrompt: string;
  readonly local?: boolean;
}

export interface WorkerSummary {
  readonly id: string;
  readonly kind: WorkerKind;
  readonly label: string;
  readonly status: WorkerStatus;
  readonly prompt: string;
  readonly summary?: string;
  readonly error?: string;
  readonly model?: string;
  readonly profileLabel?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly toolUseCount: number;
  readonly tokenCount: number;
  readonly filesInspected: readonly string[];
}

export interface WorkerTranscriptEntry {
  readonly workerId: string;
  readonly createdAt: number;
  readonly role: WorkerTranscriptRole;
  readonly text: string;
}

export type WorkerSessionEvent = "started" | "progress" | "completed" | "failed" | "stopped";
