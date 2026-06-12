// Background self-improvement review prompts — ported/adapted from Hermes `agent/background_review.py`.
//
// After a turn completes, a non-blocking review pass looks back at the conversation and curates the
// agent's memory (every N turns) and skill library (every N tool iterations). It runs with ONLY the
// memory + skill tools. These prompts shape what it saves/builds.

export const MEMORY_REVIEW_PROMPT = [
  "Review the conversation above and consider saving to memory if appropriate.",
  "",
  "Focus on:",
  "1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?",
  "2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?",
  "3. Did you discover a stable fact about the environment or repository (tooling, conventions, structure) worth keeping?",
  "",
  "Save user-facing facts with the memory tool (target 'user' for who the user is, target 'memory' for your own notes).",
  "Keep entries compact and durable. Do NOT save task progress, one-off details, or transient state.",
  "If nothing is worth saving, say 'Nothing to save.' and stop."
].join("\n");

export const SKILL_REVIEW_PROMPT = [
  "Review the conversation above and update the skill library. Be ACTIVE — most sessions that did",
  "real work produce at least one skill update, even a small one. A pass that does nothing is a missed",
  "learning opportunity, not a neutral outcome. (But never invent a skill for a trivial one-off.)",
  "",
  "Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md and, when useful, a",
  "references/ directory for session-specific detail — not a long flat list of narrow one-session",
  "skills. This shapes HOW you update, not WHETHER you update.",
  "",
  "Signals to look for (any one warrants action):",
  "  • The user corrected your style, tone, format, verbosity, or approach. Frustration signals",
  "    ('stop doing X', 'this is too verbose', 'just give me the answer', 'you always do Y') and",
  "    explicit 'remember this' are FIRST-CLASS skill signals — embed the preference in the skill",
  "    that governs that class of task so the next session starts already knowing.",
  "  • The user corrected your workflow or sequence of steps. Encode the correction as a pitfall or",
  "    explicit step in the skill that governs that class of task.",
  "  • A non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a",
  "    future session would benefit from. Capture it.",
  "  • A skill that was loaded/consulted this session turned out to be wrong, missing a step, or",
  "    outdated. Patch it NOW.",
  "",
  "Preference order — prefer the earliest action that fits:",
  "  1. PATCH AN EXISTING SKILL. Use skills_list + skill_view to find a class-level skill that covers",
  "     the territory; add a subsection, a pitfall, or broaden a trigger.",
  "  2. ADD A SUPPORT FILE under an existing skill (skill_manage action=write_file, file_path under",
  "     references/, templates/, or scripts/) for session-specific detail, then point to it from SKILL.md.",
  "  3. CREATE A NEW CLASS-LEVEL SKILL when no existing skill covers the class. The name MUST be at the",
  "     class level — NOT a PR number, error string, feature codename, or 'fix-X-today' artifact. If the",
  "     name only makes sense for today's task, fall back to (1) or (2).",
  "",
  "When the user expressed a style/format/workflow preference, the update belongs in the SKILL.md body,",
  "not just in memory. Memory captures 'who the user is and the current state'; skills capture 'how to",
  "do this class of task for this user.'",
  "",
  "Do NOT capture (these harden into self-imposed constraints that bite later):",
  "  • Environment-dependent failures: missing binaries, fresh-install errors, 'command not found',",
  "    unconfigured credentials. The user can fix these — they are not durable rules.",
  "  • Negative claims about tools/features ('X tool is broken'). These become refusals the agent cites",
  "    against itself long after the problem was fixed. Capture the FIX (the setup/config step) instead.",
  "  • Session-specific transient errors that resolved before the conversation ended.",
  "  • One-off task narratives ('summarize this PR') — not a class of work that warrants a skill.",
  "",
  "If you notice two existing skills that overlap, note it in your reply — the curator handles",
  "consolidation at scale. 'Nothing to save.' is a real option but should not be the default after a",
  "session that did real work."
].join("\n");

const COMBINED_PREAMBLE =
  "Run TWO quick reviews of the conversation above, in order: first memory, then skills. Use only the " +
  "memory and skill tools. Keep it tight.";

// Appended to the review/curator prompt so models WITHOUT native tool-calling still act: they emit
// the CodeForge JSON action protocol, which the controller parses as a fallback. Native models ignore
// this and use real tool calls. Shapes must match the tool registry's parse exactly.
export const REVIEW_TOOL_HINT = [
  "HOW TO ACT: call the memory and skill tools. If your endpoint does not support native tool calls,",
  "emit a single JSON object instead (no prose around it):",
  "{",
  '  "actions": [',
  '    { "type": "memory", "action": "add", "target": "user", "content": "a durable fact about the user" },',
  '    { "type": "memory", "action": "add", "target": "memory", "content": "a durable project or environment fact" },',
  '    { "type": "skills_list" },',
  '    { "type": "skill_view", "name": "existing-skill" },',
  '    { "type": "skill_manage", "action": "create", "name": "class-level-name", "content": "---\\nname: class-level-name\\ndescription: one line\\n---\\n# Title\\n1. step" },',
  '    { "type": "skill_manage", "action": "patch", "name": "existing-skill", "old_string": "text to find", "new_string": "replacement" }',
  "  ]",
  "}",
  "Use only the action types shown above. If nothing is worth saving, reply exactly: Nothing to save."
].join("\n");

// Prepended when the reviewed run ended badly. Anti-poisoning: an approach that failed must not be
// distilled into durable guidance the agent will follow forever. A failed run is restricted to
// outcome-independent facts and verified corrections only.
export const FAILED_RUN_CAUTION = [
  "IMPORTANT — the run you are reviewing ended with errors or was abandoned. An approach that did NOT",
  "work must never become durable guidance. For THIS review:",
  "  • Do NOT create or patch skills, and do NOT save reusable techniques, workflows, or 'how-to' notes.",
  "  • You MAY save ONLY: (a) a durable fact about the user's persona or preferences (target 'user'),",
  "    which is true regardless of whether the task succeeded; or (b) a SINGLE corrective note",
  "    (target 'memory') and ONLY if the root cause is now clearly understood and the fix was verified.",
  "  • If neither applies, reply exactly: Nothing to save."
].join("\n");

/** Select the review prompt for the cadence(s) that fired. A failed-run outcome restricts what may be saved. */
export function buildReviewPrompt(reviewMemory: boolean, reviewSkills: boolean, outcome: "ok" | "failed" = "ok"): string {
  const base = reviewMemory && reviewSkills
    ? `${COMBINED_PREAMBLE}\n\n## Memory review\n${MEMORY_REVIEW_PROMPT}\n\n## Skill review\n${SKILL_REVIEW_PROMPT}`
    : reviewSkills
      ? SKILL_REVIEW_PROMPT
      : MEMORY_REVIEW_PROMPT;
  return outcome === "failed" ? `${FAILED_RUN_CAUTION}\n\n${base}` : base;
}
