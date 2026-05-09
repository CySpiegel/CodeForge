import { AgentAction, ToolDefinition } from "./types";

interface ActionEnvelope {
  readonly actions?: readonly unknown[];
}

export const actionProtocolInstructions = `You are CodeForge, a self-hosted-first coding harness inside VS Code.

Prefer concise answers. When you need workspace data, request one or more actions using this exact JSON shape:

{
  "actions": [
    { "type": "read_file", "path": "relative/path.ts", "reason": "why" },
    { "type": "search_text", "query": "symbol or text", "reason": "why" },
    { "type": "propose_patch", "patch": "unified diff", "reason": "why" },
    { "type": "run_command", "command": "npm test", "cwd": ".", "reason": "why" }
  ]
}

Edits must be unified diffs. Do not claim that edits or commands were applied; CodeForge will ask the user to approve them.`;

export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a bounded text file from the current workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Search text in the current workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        reason: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "propose_patch",
    description: "Propose a unified diff patch for user review.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        reason: { type: "string" }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    description: "Propose a shell command to run after user approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        reason: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

export function parseActionsFromAssistantText(text: string): readonly AgentAction[] {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ActionEnvelope;
      const actions = parseActionArray(parsed.actions);
      if (actions.length > 0) {
        return actions;
      }
    } catch {
      continue;
    }
  }

  return [];
}

export function parseToolAction(name: string, argumentsJson: string): AgentAction | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    return normalizeAction({ ...parsed, type: name });
  } catch {
    return undefined;
  }
}

function extractJsonCandidates(text: string): readonly string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  return candidates;
}

function parseActionArray(actions: readonly unknown[] | undefined): readonly AgentAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.map(normalizeAction).filter((action): action is AgentAction => Boolean(action));
}

function normalizeAction(value: unknown): AgentAction | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  const reason = typeof value.reason === "string" ? value.reason : undefined;
  switch (value.type) {
    case "read_file":
      return typeof value.path === "string" ? { type: "read_file", path: value.path, reason } : undefined;
    case "search_text":
      return typeof value.query === "string" ? { type: "search_text", query: value.query, reason } : undefined;
    case "propose_patch":
      return typeof value.patch === "string" ? { type: "propose_patch", patch: value.patch, reason } : undefined;
    case "run_command":
      return typeof value.command === "string"
        ? {
          type: "run_command",
          command: value.command,
          cwd: typeof value.cwd === "string" ? value.cwd : undefined,
          reason
        }
        : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
