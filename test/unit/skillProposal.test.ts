import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEntry } from "../../src/core/memory";
import { LearnedLesson, parseLesson, serializeLessonText } from "../../src/core/learning";
import {
  buildSkillProposalPrompt,
  clusterProcedureLessons,
  parseSkillProposal,
  renderSkillMarkdown,
  sanitizeSkillName,
  skillRelativePath
} from "../../src/core/skillProposal";

function lesson(body: string, paths: readonly string[], id: string): LearnedLesson {
  const entry: MemoryEntry = {
    id,
    text: serializeLessonText({ kind: "procedure", outcome: "success", status: "accepted", paths, body }),
    createdAt: 1,
    scope: "workspace"
  };
  return parseLesson(entry)!;
}

test("clusterProcedureLessons groups by shared path or shared tokens and honours minRepeats", () => {
  const a = lesson("Configure the eslint rules before committing", ["x.ts"], "a");
  const b = lesson("Totally different wording but same file touched", ["x.ts"], "b");
  const c = lesson("Configure the eslint settings then run lint", ["y.ts"], "c");
  const lonely = lesson("An unrelated one off note here", ["z.ts"], "d");

  const clusters = clusterProcedureLessons([a, b, c, lonely], 2);
  // a+b share a path; c shares "configure"+"eslint" tokens with a -> all three cluster together.
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 3);

  assert.equal(clusterProcedureLessons([a, lonely], 2).length, 0);
  assert.equal(clusterProcedureLessons([a, b], 3).length, 0);
});

test("parseSkillProposal parses JSON objects, tolerates fences, sanitizes the name", () => {
  const ok = parseSkillProposal("```json\n{\"name\":\"Add A Tool!\",\"description\":\"how to\",\"body\":\"1. step\"}\n```");
  assert.ok(ok);
  assert.equal(ok.name, "add-a-tool");
  assert.equal(ok.body, "1. step");

  assert.equal(parseSkillProposal("not json"), undefined);
  assert.equal(parseSkillProposal("{\"name\":\"x\"}"), undefined);
  assert.equal(parseSkillProposal("{\"name\":\"123\",\"body\":\"x\"}"), undefined);
});

test("sanitizeSkillName produces safe extension names or undefined", () => {
  assert.equal(sanitizeSkillName("Refactor The Parser"), "refactor-the-parser");
  assert.equal(sanitizeSkillName("  spaced  "), "spaced");
  assert.equal(sanitizeSkillName("123-only-digits-start"), "only-digits-start");
  assert.equal(sanitizeSkillName("!!!"), undefined);
});

test("renderSkillMarkdown emits frontmatter the skills loader can parse", () => {
  const markdown = renderSkillMarkdown({ name: "add-a-tool", description: "How to add a tool", body: "1. Edit registry\n2. Edit protocol" });
  assert.ok(markdown.startsWith("---\n"));
  assert.match(markdown, /\nname: add-a-tool\n/);
  assert.match(markdown, /\ndescription: How to add a tool\n/);
  assert.match(markdown, /\n---\n1\. Edit registry/);
  assert.equal(skillRelativePath("add-a-tool"), ".codeforge/skills/add-a-tool/SKILL.md");
});

test("buildSkillProposalPrompt lists the clustered procedures", () => {
  const cluster = [lesson("Edit toolRegistry then actionProtocol", ["src/core/toolRegistry.ts"], "a"), lesson("Then register the schema", ["src/core/toolRegistry.ts"], "b")];
  const { user } = buildSkillProposalPrompt(cluster);
  assert.match(user, /Edit toolRegistry then actionProtocol/);
  assert.match(user, /files: src\/core\/toolRegistry\.ts/);
});
