import { LearnedLesson } from "./learning";
import { isSafeExtensionName } from "./localExtensions";

// Hermes-style skill proposal: when the same successful procedure recurs, synthesise it into a
// reusable .codeforge/skills/<name>/SKILL.md (markdown + YAML frontmatter, the format
// loadLocalSkills already understands).

export interface ProposedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const MIN_SHARED_TOKENS = 2;

export function clusterProcedureLessons(lessons: readonly LearnedLesson[], minRepeats: number): readonly (readonly LearnedLesson[])[] {
  const clusters: LearnedLesson[][] = [];
  for (const lesson of lessons) {
    const target = clusters.find((cluster) => cluster.some((member) => lessonsAreSimilar(member, lesson)));
    if (target) {
      target.push(lesson);
    } else {
      clusters.push([lesson]);
    }
  }
  return clusters.filter((cluster) => cluster.length >= Math.max(2, minRepeats));
}

export function clusterSignature(cluster: readonly LearnedLesson[]): string {
  return [...cluster].map((lesson) => lesson.id).sort().join("|");
}

export function buildSkillProposalPrompt(cluster: readonly LearnedLesson[]): { readonly system: string; readonly user: string } {
  const system = [
    "You convert a repeated, successful engineering procedure into ONE reusable skill for an AI coding agent.",
    "Output ONLY a JSON object (no prose, no code fences): {\"name\":string,\"description\":string,\"body\":string}.",
    "name: lowercase kebab-case, <=64 chars, starts with a letter. description: a single concise line. body: clear numbered markdown steps the agent can follow next time.",
    "Generalise across the examples; do not hard-code one-off details."
  ].join("\n");
  const user = [
    "These learned procedure lessons describe the same recurring workflow:",
    ...cluster.map((lesson, index) => `${index + 1}. ${lesson.body}${lesson.paths.length ? ` (files: ${lesson.paths.join(", ")})` : ""}`),
    "",
    "Return the skill JSON now."
  ].join("\n");
  return { system, user };
}

export function parseSkillProposal(text: string): ProposedSkill | undefined {
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
  const description = typeof parsed.description === "string" ? parsed.description.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!name || !body) {
    return undefined;
  }
  return { name, description: description || `CodeForge learned skill ${name}`, body };
}

export function renderSkillMarkdown(skill: ProposedSkill): string {
  const description = skill.description.replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${description}`,
    "generated-by: codeforge-learning",
    "---",
    skill.body.trim(),
    ""
  ].join("\n");
}

export function skillRelativePath(name: string): string {
  return `.codeforge/skills/${name}/SKILL.md`;
}

export function sanitizeSkillName(value: string): string | undefined {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug && isSafeExtensionName(slug) ? slug : undefined;
}

function lessonsAreSimilar(a: LearnedLesson, b: LearnedLesson): boolean {
  if (sharePath(a.paths, b.paths)) {
    return true;
  }
  const tokensA = tokenize(a.body);
  const tokensB = tokenize(b.body);
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      shared += 1;
    }
  }
  return shared >= MIN_SHARED_TOKENS;
}

function sharePath(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map((path) => path.toLowerCase()));
  return b.some((path) => set.has(path.toLowerCase()));
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length > 3) {
      tokens.add(raw);
    }
  }
  return tokens;
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
