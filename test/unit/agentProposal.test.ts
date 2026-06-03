import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEntry } from "../../src/core/memory";
import { LearnedLesson, parseLesson, serializeLessonText } from "../../src/core/learning";
import { agentRelativePath, buildAgentProposalPrompt, parseAgentProposal, renderAgentMarkdown } from "../../src/core/agentProposal";
import { loadLocalAgents } from "../../src/core/localExtensions";
import { ContextItem, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../../src/core/types";

const allowedTools = ["read_file", "edit_file", "search_text", "run_command"];

function lesson(body: string, id: string): LearnedLesson {
  const entry: MemoryEntry = { id, text: serializeLessonText({ kind: "fix", outcome: "failure", status: "accepted", paths: ["src/auth.ts"], body }), createdAt: 1, scope: "workspace" };
  return parseLesson(entry)!;
}

test("buildAgentProposalPrompt lists the cluster and constrains the toolset", () => {
  const { system, user } = buildAgentProposalPrompt([lesson("auth tokens expire", "a"), lesson("refresh on 401", "b")], allowedTools);
  assert.match(system, /subset of these exact names: read_file, edit_file/);
  assert.match(user, /auth tokens expire/);
});

test("parseAgentProposal sanitizes the name and validates tools against the registry", () => {
  const agent = parseAgentProposal(
    "```json\n{\"name\":\"Auth Fixer\",\"label\":\"Auth\",\"description\":\"fix auth\",\"tools\":[\"read_file\",\"edit_file\",\"definitely_not_a_tool\"],\"body\":\"Fix auth issues.\"}\n```",
    allowedTools
  );
  assert.ok(agent);
  assert.equal(agent.name, "auth-fixer");
  assert.deepEqual(agent.tools, ["read_file", "edit_file"]);
  assert.equal(agent.body, "Fix auth issues.");

  assert.equal(parseAgentProposal("{\"name\":\"x\"}", allowedTools), undefined);
  assert.equal(parseAgentProposal("not json", allowedTools), undefined);
});

test("renderAgentMarkdown produces an AGENT.md the loader parses", async () => {
  const markdown = renderAgentMarkdown({ name: "auth-fixer", label: "Auth Fixer", description: "Fix auth token issues", tools: ["read_file", "edit_file"], body: "Diagnose and fix auth token problems." });
  const workspace = new FakeAgentWorkspace({ ".codeforge/agents/auth-fixer/AGENT.md": markdown });
  const agents = await loadLocalAgents(workspace);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "auth-fixer");
  assert.equal(agents[0].label, "Auth Fixer");
  assert.deepEqual(agents[0].tools, ["read_file", "edit_file"]);
  assert.equal(agents[0].maxTurns, 8);
  assert.equal(agentRelativePath("auth-fixer"), ".codeforge/agents/auth-fixer/AGENT.md");
});

class FakeAgentWorkspace implements WorkspacePort {
  constructor(private readonly files: Readonly<Record<string, string>>) {}
  async listTextFiles(): Promise<readonly string[]> { return Object.keys(this.files); }
  async listFiles(): Promise<readonly string[]> { return Object.keys(this.files); }
  async globFiles(pattern: string): Promise<readonly string[]> {
    if (pattern === ".codeforge/agents/*/AGENT.md") {
      return Object.keys(this.files).filter((path) => /^\.codeforge\/agents\/[^/]+\/AGENT\.md$/.test(path));
    }
    return [];
  }
  async readTextFile(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) { throw new Error("missing"); }
    return content;
  }
  async getActiveTextDocument(): Promise<ContextItem | undefined> { return undefined; }
  async getOpenTextDocuments(): Promise<readonly ContextItem[]> { return []; }
  async getActiveSelection(): Promise<ContextItem | undefined> { return undefined; }
  async searchText(): Promise<readonly SearchResult[]> { return []; }
  async grepText(): Promise<readonly SearchResult[]> { return []; }
  async getDiagnostics(): Promise<readonly WorkspaceDiagnostic[]> { return []; }
}
