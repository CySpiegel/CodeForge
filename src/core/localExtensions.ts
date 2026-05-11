import { AgentAction, RunCommandAction, WorkspacePort } from "./types";

const commandsGlob = ".codeforge/commands/*.md";
const skillsFileGlob = ".codeforge/skills/*.md";
const skillsDirectoryGlob = ".codeforge/skills/*/SKILL.md";
const agentsFileGlob = ".codeforge/agents/*.md";
const agentsDirectoryGlob = ".codeforge/agents/*/AGENT.md";
const hooksPath = ".codeforge/hooks.json";

export interface LocalCommand {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly skills: readonly string[];
  readonly body: string;
}

export interface LocalSkill {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly body: string;
}

export interface LocalAgent {
  readonly name: string;
  readonly path: string;
  readonly label?: string;
  readonly description?: string;
  readonly tools: readonly string[];
  readonly maxTurns?: number;
  readonly body: string;
}

export type LocalHookEvent = "preTool" | "postTool" | "postToolFailure";

export interface LocalHook {
  readonly name: string;
  readonly path: string;
  readonly event: LocalHookEvent;
  readonly tools: readonly string[];
  readonly command: RunCommandAction;
  readonly timeoutSeconds?: number;
  readonly description?: string;
}

interface ParsedMarkdownFile {
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: string;
}

export async function loadLocalCommands(workspace: WorkspacePort, signal?: AbortSignal): Promise<readonly LocalCommand[]> {
  const paths = await safeGlob(workspace, commandsGlob, 100, signal);
  const commands: LocalCommand[] = [];
  for (const path of [...paths].sort()) {
    const name = extensionNameFromPath(path);
    if (!name || !isSafeExtensionName(name)) {
      continue;
    }
    const parsed = parseMarkdownFile(await workspace.readTextFile(path, 128000, signal));
    if (!parsed.body.trim()) {
      continue;
    }
    commands.push({
      name,
      path,
      description: metadataValue(parsed.metadata, "description"),
      argumentHint: metadataValue(parsed.metadata, "argument-hint") ?? metadataValue(parsed.metadata, "argumentHint"),
      skills: metadataList(parsed.metadata, "skills"),
      body: parsed.body.trim()
    });
  }
  return commands;
}

export async function loadLocalSkills(workspace: WorkspacePort, signal?: AbortSignal): Promise<readonly LocalSkill[]> {
  const paths = [
    ...await safeGlob(workspace, skillsFileGlob, 100, signal),
    ...await safeGlob(workspace, skillsDirectoryGlob, 100, signal)
  ].sort();
  const byName = new Map<string, LocalSkill>();
  for (const path of paths) {
    const name = skillNameFromPath(path);
    if (!name || !isSafeExtensionName(name) || byName.has(name)) {
      continue;
    }
    const parsed = parseMarkdownFile(await workspace.readTextFile(path, 128000, signal));
    if (!parsed.body.trim()) {
      continue;
    }
    byName.set(name, {
      name,
      path,
      description: metadataValue(parsed.metadata, "description"),
      body: parsed.body.trim()
    });
  }
  return [...byName.values()];
}

export async function loadLocalAgents(workspace: WorkspacePort, signal?: AbortSignal): Promise<readonly LocalAgent[]> {
  const paths = [
    ...await safeGlob(workspace, agentsFileGlob, 100, signal),
    ...await safeGlob(workspace, agentsDirectoryGlob, 100, signal)
  ].sort();
  const byName = new Map<string, LocalAgent>();
  for (const path of paths) {
    const name = agentNameFromPath(path);
    if (!name || !isSafeExtensionName(name) || byName.has(name)) {
      continue;
    }
    const parsed = parseMarkdownFile(await workspace.readTextFile(path, 128000, signal));
    if (!parsed.body.trim()) {
      continue;
    }
    byName.set(name, {
      name,
      path,
      label: metadataValue(parsed.metadata, "label"),
      description: metadataValue(parsed.metadata, "description"),
      tools: metadataList(parsed.metadata, "tools").map((tool) => tool.toLowerCase()),
      maxTurns: metadataPositiveInteger(parsed.metadata, "max-turns") ?? metadataPositiveInteger(parsed.metadata, "maxTurns"),
      body: parsed.body.trim()
    });
  }
  return [...byName.values()];
}

export async function loadLocalHooks(workspace: WorkspacePort, signal?: AbortSignal): Promise<readonly LocalHook[]> {
  let raw = "";
  try {
    raw = await workspace.readTextFile(hooksPath, 128000, signal);
  } catch {
    return [];
  }
  return parseLocalHooks(raw, hooksPath);
}

export function parseLocalHooks(raw: string, path = hooksPath): readonly LocalHook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const hookItems = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.hooks)
      ? parsed.hooks
      : [];
  return hookItems.map((item, index) => parseLocalHook(item, path, index)).filter((hook): hook is LocalHook => Boolean(hook));
}

export function localHookMatches(hook: LocalHook, event: LocalHookEvent, action: AgentAction): boolean {
  return hook.event === event && (hook.tools.length === 0 || hook.tools.some((pattern) => wildcardMatch(pattern, action.type)));
}

export function renderLocalCommand(command: LocalCommand, args: string, skills: readonly LocalSkill[] = []): string {
  const skillText = command.skills
    .map((name) => skills.find((skill) => skill.name === name))
    .filter((skill): skill is LocalSkill => Boolean(skill))
    .map(formatSkillInstruction)
    .join("\n\n");
  const replaced = replaceTemplateArgs(command.body, args);
  const body = command.body === replaced && args.trim()
    ? `${replaced}\n\nUser arguments:\n${args.trim()}`
    : replaced;
  return [
    `Run local CodeForge command /${command.name} from ${command.path}.`,
    skillText || undefined,
    body
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function renderLocalSkillPrompt(skill: LocalSkill, task: string): string {
  return [
    `Use local CodeForge skill "${skill.name}" from ${skill.path}.`,
    skill.description ? `Skill description: ${skill.description}` : undefined,
    "Skill instructions:",
    skill.body,
    "User task:",
    task.trim() || "Apply this skill to the current repo context."
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function formatLocalCommandList(commands: readonly LocalCommand[]): string {
  if (commands.length === 0) {
    return "No local CodeForge commands found. Add markdown files under .codeforge/commands/*.md.";
  }
  return [
    "Local CodeForge commands:",
    ...commands.map((command) => {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      const description = command.description ? ` - ${command.description}` : "";
      const skills = command.skills.length > 0 ? ` [skills: ${command.skills.join(", ")}]` : "";
      return `- /${command.name}${hint}${description}${skills} (${command.path})`;
    })
  ].join("\n");
}

export function formatLocalSkillList(skills: readonly LocalSkill[]): string {
  if (skills.length === 0) {
    return "No local CodeForge skills found. Add markdown files under .codeforge/skills/*.md or .codeforge/skills/<name>/SKILL.md.";
  }
  return [
    "Local CodeForge skills:",
    ...skills.map((skill) => `- ${skill.name}${skill.description ? ` - ${skill.description}` : ""} (${skill.path})`)
  ].join("\n");
}

export function formatLocalAgentList(agents: readonly LocalAgent[]): string {
  if (agents.length === 0) {
    return "No local CodeForge agents found. Add markdown files under .codeforge/agents/*.md or .codeforge/agents/<name>/AGENT.md.";
  }
  return [
    "Local CodeForge agents:",
    ...agents.map((agent) => {
      const label = agent.label && agent.label !== agent.name ? `${agent.label} ` : "";
      const tools = agent.tools.length > 0 ? ` [tools: ${agent.tools.join(", ")}]` : " [tools: read]";
      const description = agent.description ? ` - ${agent.description}` : "";
      return `- ${agent.name}${label ? ` (${label.trim()})` : ""}${description}${tools} (${agent.path})`;
    })
  ].join("\n");
}

function parseLocalHook(value: unknown, path: string, index: number): LocalHook | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const event = parseHookEvent(value.event ?? value.on);
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!event || !command) {
    return undefined;
  }
  const tools = parseTools(value.tools ?? value.tool);
  const name = typeof value.name === "string" && isSafeHookName(value.name.trim())
    ? value.name.trim()
    : `${event}-${index + 1}`;
  const cwd = typeof value.cwd === "string" ? value.cwd.trim() || undefined : undefined;
  const timeoutSeconds = positiveInteger(value.timeoutSeconds ?? value.timeout_seconds);
  return {
    name,
    path,
    event,
    tools,
    command: {
      type: "run_command",
      command,
      cwd,
      reason: `Local CodeForge ${event} hook ${name}`
    },
    timeoutSeconds,
    description: typeof value.description === "string" ? value.description : undefined
  };
}

function parseHookEvent(value: unknown): LocalHookEvent | undefined {
  return value === "preTool" || value === "postTool" || value === "postToolFailure" ? value : undefined;
}

function parseTools(value: unknown): readonly string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

async function safeGlob(workspace: WorkspacePort, pattern: string, limit: number, signal?: AbortSignal): Promise<readonly string[]> {
  try {
    return await workspace.globFiles(pattern, limit, signal);
  } catch {
    return [];
  }
}

function parseMarkdownFile(raw: string): ParsedMarkdownFile {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { metadata: {}, body: normalized };
  }
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + "\n---\n".length);
  return { metadata: parseSimpleFrontmatter(frontmatter), body };
}

function parseSimpleFrontmatter(frontmatter: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) {
      result[key] = stripQuotes(value);
    }
  }
  return result;
}

function metadataValue(metadata: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = metadata[key]?.trim();
  return value ? value : undefined;
}

function metadataList(metadata: Readonly<Record<string, string>>, key: string): readonly string[] {
  const raw = metadataValue(metadata, key);
  if (!raw) {
    return [];
  }
  return raw.replace(/^\[/, "").replace(/\]$/, "").split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
}

function metadataPositiveInteger(metadata: Readonly<Record<string, string>>, key: string): number | undefined {
  const raw = metadataValue(metadata, key);
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function replaceTemplateArgs(value: string, args: string): string {
  return value.replace(/\{\{\s*(args|input)\s*\}\}/gi, args.trim());
}

function formatSkillInstruction(skill: LocalSkill): string {
  return [
    `Local skill "${skill.name}" from ${skill.path}:`,
    skill.description ? `Description: ${skill.description}` : undefined,
    skill.body
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

function extensionNameFromPath(path: string): string | undefined {
  const basename = path.split("/").pop() ?? "";
  return basename.endsWith(".md") ? basename.slice(0, -3) : undefined;
}

function skillNameFromPath(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.at(-1) === "SKILL.md") {
    return parts.at(-2);
  }
  return extensionNameFromPath(path);
}

function agentNameFromPath(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.at(-1) === "AGENT.md") {
    return parts.at(-2);
  }
  return extensionNameFromPath(path);
}

function isSafeExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
}

function isSafeHookName(value: string): boolean {
  return /^[a-z0-9_.:-]{1,96}$/i.test(value);
}

function stripQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern || pattern === "*") {
    return pattern === "*";
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
