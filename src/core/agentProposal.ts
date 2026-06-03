import { LearnedLesson } from "./learning";
import { sanitizeSkillName } from "./skillProposal";

// Hermes-style "refine your agents from experience": when a recurring *kind of task* shows up
// across many learned lessons, propose a specialized sub-agent definition
// (.codeforge/agents/<name>/AGENT.md, the format loadLocalAgents already parses).
// Agents grant a toolset, so a proposal is ALWAYS review-only and its tools are validated against
// the real tool registry — a learned agent can never grant itself capabilities that do not exist.

export interface ProposedAgent {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly body: string;
}

export function buildAgentProposalPrompt(cluster: readonly LearnedLesson[], allowedTools: readonly string[]): { readonly system: string; readonly user: string } {
  const system = [
    "You define a specialized sub-agent for a recurring kind of task an AI coding agent keeps doing.",
    "Output ONLY a JSON object (no prose, no code fences): {\"name\":string,\"label\":string,\"description\":string,\"tools\":string[],\"body\":string}.",
    "name: lowercase kebab-case, <=64 chars, starts with a letter. label: short title. description: one line. body: the agent's system prompt (how it should approach this task type).",
    `tools MUST be a subset of these exact names: ${allowedTools.join(", ")}. Choose the minimum needed; omit anything not required.`
  ].join("\n");
  const user = [
    "These recurring learned lessons describe the same kind of task:",
    ...cluster.map((lesson, index) => `${index + 1}. [${lesson.kind}] ${lesson.body}${lesson.paths.length ? ` (files: ${lesson.paths.join(", ")})` : ""}`),
    "",
    "Return the sub-agent JSON now."
  ].join("\n");
  return { system, user };
}

export function parseAgentProposal(text: string, allowedTools: readonly string[]): ProposedAgent | undefined {
  const objectText = extractJsonObject(text);
  if (!objectText) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const name = sanitizeSkillName(typeof parsed.name === "string" ? parsed.name : "");
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!name || !body) {
    return undefined;
  }
  const allowed = new Set(allowedTools.map((tool) => tool.toLowerCase()));
  const tools = Array.isArray(parsed.tools)
    ? [...new Set(parsed.tools
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => tool.trim().toLowerCase())
      .filter((tool) => allowed.has(tool)))]
    : [];
  const label = typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim().slice(0, 80) : name;
  const description = typeof parsed.description === "string" ? parsed.description.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { name, label, description: description || `CodeForge learned agent ${name}`, tools, body };
}

export function renderAgentMarkdown(agent: ProposedAgent): string {
  const lines = [
    "---",
    `label: ${agent.label}`,
    `description: ${agent.description.replace(/\r?\n/g, " ").trim()}`
  ];
  if (agent.tools.length > 0) {
    lines.push(`tools: ${agent.tools.join(", ")}`);
  }
  lines.push("max-turns: 8", "generated-by: codeforge-learning", "---", agent.body.trim(), "");
  return lines.join("\n");
}

export function agentRelativePath(name: string): string {
  return `.codeforge/agents/${name}/AGENT.md`;
}

function extractJsonObject(text: string): string | undefined {
  const withoutFences = text.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return withoutFences.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
