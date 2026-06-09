// Local skills helpers — loading lives in localExtensions.ts; this module ranks/formats skills
// for injection into a sub-agent's context. (Re-homed from the deleted learning/skillProposal
// pipeline; the agent now authors skills directly via the skill tool.)

export function formatSkillsDigest(
  skills: readonly { readonly name: string; readonly description?: string; readonly body: string }[],
  prompt: string,
  maxBytes: number
): string {
  if (skills.length === 0 || maxBytes <= 0) {
    return "";
  }
  const promptTokens = tokenize(prompt);
  const ranked = skills
    .map((skill, index) => ({ skill, index, score: skillRelevance(skill, promptTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.skill);
  if (ranked.length === 0) {
    return "";
  }
  const header = "Relevant skills — follow these procedures when they apply:";
  const blocks: string[] = [header];
  let used = Buffer.byteLength(header, "utf8");
  for (const skill of ranked) {
    const block = `\n\n### ${skill.name}${skill.description ? ` — ${skill.description}` : ""}\n${skill.body.trim()}`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (used + blockBytes > maxBytes) {
      break;
    }
    blocks.push(block);
    used += blockBytes;
  }
  return blocks.length > 1 ? blocks.join("") : "";
}

function skillRelevance(skill: { readonly name: string; readonly description?: string; readonly body: string }, promptTokens: Set<string>): number {
  const skillTokens = tokenize(`${skill.name} ${skill.description ?? ""} ${skill.body}`);
  let shared = 0;
  for (const token of skillTokens) {
    if (promptTokens.has(token)) {
      shared += 1;
    }
  }
  return shared;
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
