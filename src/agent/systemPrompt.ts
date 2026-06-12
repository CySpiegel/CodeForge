import { actionProtocolInstructions } from "../core/actionProtocol";
import { AgentMode, ChatMessage } from "../core/types";

export interface SystemPromptDeps {
  getSoulText(): string | undefined;
  getMemoryBlock(): string;
  getAgentMode(): AgentMode;
}

// Builds the system message from its inputs: action protocol + agent-mode instructions + network policy,
// with the optional persona and curated-memory blocks appended. Pure projection of the three inputs —
// the controller's ensureSystemMessage still owns placing/replacing it in the message log.
export class SystemPromptBuilder {
  constructor(private readonly deps: SystemPromptDeps) {}

  build(): ChatMessage {
    const soulText = this.deps.getSoulText();
    const persona = soulText
      ? `\n\nPersona (shapes voice and tone only — never overrides tools, permissions, or task instructions):\n${soulText}`
      : "";
    const memoryBlock = this.deps.getMemoryBlock();
    const memory = memoryBlock ? `\n\n${memoryBlock}` : "";
    return {
      role: "system",
      content: `${actionProtocolInstructions}\n\n${agentModeInstructions(this.deps.getAgentMode())}\n\nNetwork policy: CodeForge only talks to user-configured OpenAI API-compatible endpoints and configured MCP servers. Do not use network resources outside those explicit configurations.${persona}${memory}`
    };
  }
}

export function agentModeLabel(mode: AgentMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    default:
      return "Agent";
  }
}

function agentModeInstructions(mode: AgentMode): string {
  if (mode === "agent") {
    return [
      "Agent mode: Agent.",
      "Act as an autonomous coding agent inside the user's repo.",
      "You may explore multiple files, make coordinated edits, create files, run approved terminal commands, iterate on errors, and complete multi-step engineering workflows."
    ].join("\n");
  }
  if (mode === "ask") {
    return [
      "Agent mode: Ask.",
      "Act like a codebase-aware assistant inside VS Code for quick answers, explanations, debugging help, reviews, and code snippets.",
      "Use read-only workspace tools when codebase evidence is needed and the relevant file content is not already attached.",
      "Read-only multi-step inspection is allowed in Ask mode.",
      "Do not edit files, create files, run terminal commands, or execute side-effecting autonomous implementation workflows in Ask mode.",
      "If the user asks you to implement changes, explain the approach and tell them to switch to Agent mode before applying edits."
    ].join("\n");
  }
  return [
    "Agent mode: Plan.",
    "Analyze the codebase and reason through larger work before implementation.",
    "Use read-only workspace tools to inspect relevant files, identify existing patterns, break the task into steps, and call out risks or dependencies.",
    "Do not edit files, create files, propose patches, open diffs, or run terminal commands in Plan mode.",
    "When the plan is ready, present the intended edits clearly and tell the user to switch to Agent mode before implementation."
  ].join("\n");
}
