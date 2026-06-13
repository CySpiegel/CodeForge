import type { CodeForgeTool } from "../toolRegistry";
import { invalidToolType, isSafeExtensionName, isSafeWorkerId, optionalString } from "../toolValidation";

export const workerTools: readonly CodeForgeTool[] = [
  {
    name: "spawn_agent",
    description: "Launch a CodeForge built-in or workspace-local agent to investigate, review, verify, or implement a task.",
    searchHint: "delegate local agent work",
    risk: "automation",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        background: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.prompt === "string"
        ? {
          type: "spawn_agent",
          agent: optionalString(input.agent),
          prompt: input.prompt,
          description: optionalString(input.description),
          background: typeof input.background === "boolean" ? input.background : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "spawn_agent") {
        return invalidToolType(action, "spawn_agent");
      }
      if (!action.prompt.trim()) {
        return { ok: false, message: "Agent prompt must not be empty." };
      }
      if (action.prompt.length > 24000) {
        return { ok: false, message: "Agent prompt is too long." };
      }
      if (action.agent && !isSafeExtensionName(action.agent)) {
        return { ok: false, message: "Agent name must contain only letters, numbers, underscores, or dashes." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "spawn_agent" ? `Launch agent ${action.agent || "implement"}` : "Launch agent";
    }
  },
  {
    name: "worker_output",
    description: "Read a CodeForge worker/agent's status and transcript. Set wait=true to block until it finishes — spawn several agents, then read each back with wait=true to run them in parallel and join the results.",
    searchHint: "read worker transcript",
    risk: "automation",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string" },
        wait: { type: "boolean", description: "Block until the worker finishes before returning its transcript." },
        reason: { type: "string" }
      },
      required: ["workerId"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.workerId === "string"
        ? { type: "worker_output", workerId: input.workerId, wait: input.wait === true, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "worker_output") {
        return invalidToolType(action, "worker_output");
      }
      return isSafeWorkerId(action.workerId)
        ? { ok: true }
        : { ok: false, message: "Worker id is invalid." };
    },
    summarize(action) {
      return action.type === "worker_output" ? `Read worker output ${action.workerId}` : "Read worker output";
    }
  },
];
