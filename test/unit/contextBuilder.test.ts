import test from "node:test";
import assert from "node:assert/strict";
import { ContextBuilder } from "../../src/core/contextBuilder";
import { MemoryEntry } from "../../src/core/memory";
import { ContextItem, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../../src/core/types";

test("loads local project instructions and explicit memories before repo files", async () => {
  const memories: MemoryEntry[] = [
    { id: "memory-1", text: "Prefer focused tests.", createdAt: 1 }
  ];
  const builder = new ContextBuilder(new FakeWorkspace(), { maxBytes: 20000, maxFiles: 10 }, { memories });

  const items = await builder.build();

  assert.equal(items[0]?.kind, "projectInstructions");
  assert.equal(items[0]?.label, "CODEFORGE.md");
  assert.equal(items[1]?.kind, "projectInstructions");
  assert.equal(items[1]?.label, "CLAUDE.md");
  assert.equal(items[2]?.kind, "memory");
  assert.match(builder.format(items), /Prefer focused tests/);
});

test("does not attach active or open editor files unless they are pinned", async () => {
  const active: ContextItem = {
    kind: "activeFile",
    label: "src/new-file.ts",
    content: "[CodeForge active file is empty. Use write_file with path \"src/new-file.ts\".]"
  };
  const builder = new ContextBuilder(
    new FakeWorkspace(active, [{ kind: "openFile", label: "src/new-file.ts", content: "" }]),
    { maxBytes: 20000, maxFiles: 10 }
  );

  const items = await builder.build();

  assert.equal(items.some((item) => item.kind === "activeFile"), false);
  assert.equal(items.some((item) => item.kind === "openFile"), false);
  assert.equal(items.some((item) => item.label === "src/new-file.ts"), false);
});

class FakeWorkspace implements WorkspacePort {
  constructor(
    private readonly activeDocument?: ContextItem,
    private readonly openDocuments: readonly ContextItem[] = []
  ) {}

  async listTextFiles(): Promise<readonly string[]> {
    return ["src/index.ts", "README.md"];
  }

  async listFiles(): Promise<readonly string[]> {
    return ["src/index.ts", "README.md"];
  }

  async globFiles(): Promise<readonly string[]> {
    return ["src/index.ts"];
  }

  async readTextFile(path: string): Promise<string> {
    if (path === "CODEFORGE.md") {
      return "Use local endpoints only.\n";
    }
    if (path === "CLAUDE.md") {
      return "Legacy project note.\n";
    }
    throw new Error("missing");
  }

  async getActiveTextDocument(): Promise<ContextItem | undefined> {
    return this.activeDocument;
  }

  async getOpenTextDocuments(): Promise<readonly ContextItem[]> {
    return this.openDocuments;
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
