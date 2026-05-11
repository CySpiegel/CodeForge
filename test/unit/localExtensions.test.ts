import test from "node:test";
import assert from "node:assert/strict";
import {
  formatLocalCommandList,
  formatLocalAgentList,
  formatLocalSkillList,
  loadLocalAgents,
  loadLocalCommands,
  loadLocalHooks,
  loadLocalSkills,
  localHookMatches,
  parseLocalHooks,
  renderLocalCommand,
  renderLocalSkillPrompt
} from "../../src/core/localExtensions";
import { ContextItem, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../../src/core/types";

test("loads local slash commands from workspace markdown files", async () => {
  const workspace = new FakeWorkspace({
    ".codeforge/commands/review.md": `---
description: Run a focused review
argument-hint: <path>
skills: reviewer, typescript
---
Review {{args}} and report bugs first.
`,
    ".codeforge/commands/bad name.md": "ignored"
  });

  const commands = await loadLocalCommands(workspace);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "review");
  assert.equal(commands[0].description, "Run a focused review");
  assert.deepEqual(commands[0].skills, ["reviewer", "typescript"]);
  assert.match(formatLocalCommandList(commands), /\/review <path>/);
});

test("renders command prompts with referenced local skills", async () => {
  const workspace = new FakeWorkspace({
    ".codeforge/commands/review.md": `---
skills: reviewer
---
Review {{args}}.
`,
    ".codeforge/skills/reviewer.md": `---
description: Review defects first
---
Prioritize correctness and missing tests.
`
  });

  const [command] = await loadLocalCommands(workspace);
  const skills = await loadLocalSkills(workspace);
  const prompt = renderLocalCommand(command, "src/index.ts", skills);

  assert.match(prompt, /Run local CodeForge command \/review/);
  assert.match(prompt, /Prioritize correctness/);
  assert.match(prompt, /Review src\/index.ts/);
});

test("loads local skills from flat files and SKILL.md directories", async () => {
  const workspace = new FakeWorkspace({
    ".codeforge/skills/reviewer.md": "Review carefully.",
    ".codeforge/skills/typescript/SKILL.md": `---
description: TypeScript practices
---
Use strict TypeScript patterns.
`
  });

  const skills = await loadLocalSkills(workspace);

  assert.deepEqual(skills.map((skill) => skill.name), ["reviewer", "typescript"]);
  assert.match(formatLocalSkillList(skills), /typescript - TypeScript practices/);
  assert.match(renderLocalSkillPrompt(skills[1], "Fix types"), /Use strict TypeScript patterns/);
});

test("loads local agents from flat files and AGENT.md directories", async () => {
  const workspace = new FakeWorkspace({
    ".codeforge/agents/code-reviewer.md": `---
label: Code Reviewer
description: Review code for correctness
tools: read, edit
max-turns: 8
---
Review changes for defects before style comments.
`,
    ".codeforge/agents/planner/AGENT.md": `---
description: Planning agent
tools: read
---
Plan implementation work.
`
  });

  const agents = await loadLocalAgents(workspace);

  assert.deepEqual(agents.map((agent) => agent.name), ["code-reviewer", "planner"]);
  assert.equal(agents[0].label, "Code Reviewer");
  assert.deepEqual(agents[0].tools, ["read", "edit"]);
  assert.equal(agents[0].maxTurns, 8);
  assert.match(formatLocalAgentList(agents), /code-reviewer/);
  assert.match(formatLocalAgentList(agents), /tools: read, edit/);
});

test("parses local hooks and matches tool events", () => {
  const hooks = parseLocalHooks(JSON.stringify({
    hooks: [
      {
        name: "typecheck",
        event: "preTool",
        tools: ["write_file", "edit_file"],
        command: "npm run compile",
        timeoutSeconds: 30
      },
      {
        event: "postTool",
        tools: "*",
        command: "npm test"
      },
      {
        event: "bad",
        command: "ignored"
      }
    ]
  }));

  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].name, "typecheck");
  assert.equal(hooks[0].command.command, "npm run compile");
  assert.equal(hooks[0].timeoutSeconds, 30);
  assert.equal(localHookMatches(hooks[0], "preTool", { type: "write_file", path: "src/a.ts", content: "" }), true);
  assert.equal(localHookMatches(hooks[0], "preTool", { type: "run_command", command: "npm test" }), false);
  assert.equal(localHookMatches(hooks[1], "postTool", { type: "run_command", command: "npm test" }), true);
});

test("loads hooks from .codeforge/hooks.json when present", async () => {
  const workspace = new FakeWorkspace({
    ".codeforge/hooks.json": JSON.stringify([
      { event: "preTool", tools: ["run_command"], command: "npm run lint" }
    ])
  });

  const hooks = await loadLocalHooks(workspace);

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].path, ".codeforge/hooks.json");
});

class FakeWorkspace implements WorkspacePort {
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async listTextFiles(): Promise<readonly string[]> {
    return Object.keys(this.files);
  }

  async listFiles(): Promise<readonly string[]> {
    return Object.keys(this.files);
  }

  async globFiles(pattern: string): Promise<readonly string[]> {
    if (pattern === ".codeforge/commands/*.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/commands\/[^/]+\.md$/.test(path));
    }
    if (pattern === ".codeforge/skills/*.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/skills\/[^/]+\.md$/.test(path));
    }
    if (pattern === ".codeforge/skills/*/SKILL.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/skills\/[^/]+\/SKILL\.md$/.test(path));
    }
    if (pattern === ".codeforge/agents/*.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/agents\/[^/]+\.md$/.test(path));
    }
    if (pattern === ".codeforge/agents/*/AGENT.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/agents\/[^/]+\/AGENT\.md$/.test(path));
    }
    return [];
  }

  async readTextFile(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error("missing");
    }
    return content;
  }

  async getActiveTextDocument(): Promise<ContextItem | undefined> {
    return undefined;
  }

  async getOpenTextDocuments(): Promise<readonly ContextItem[]> {
    return [];
  }

  async getActiveSelection(): Promise<ContextItem | undefined> {
    return undefined;
  }

  async searchText(): Promise<readonly SearchResult[]> {
    return [];
  }

  async grepText(): Promise<readonly SearchResult[]> {
    return [];
  }

  async getDiagnostics(): Promise<readonly WorkspaceDiagnostic[]> {
    return [];
  }
}
