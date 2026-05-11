import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkspaceIndex } from "../../src/core/workspaceIndex";
import { ContextItem, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../../src/core/types";

test("builds an offline workspace index with files, symbols, imports, and diagnostics", async () => {
  const workspace = new IndexedWorkspace({
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "src/index.ts": "import { add } from './math';\nexport function main() { return add(1, 2); }\n",
    "src/math.ts": "export function add(a: number, b: number) { return a + b; }\n"
  }, [
    { path: "src/index.ts", line: 2, character: 10, severity: "warning", message: "Example warning" }
  ]);

  const item = await buildWorkspaceIndex(workspace, { maxFiles: 20, maxAnalyzedFiles: 10, maxBytesPerFile: 8000 });

  assert.equal(item?.kind, "workspaceIndex");
  assert.match(item?.content ?? "", /Total indexed files: 3/);
  assert.match(item?.content ?? "", /Important files:\n- package\.json/);
  assert.match(item?.content ?? "", /symbols: main/);
  assert.match(item?.content ?? "", /imports: \.\/math/);
  assert.match(item?.content ?? "", /warning src\/index\.ts:2:10 Example warning/);
});

class IndexedWorkspace implements WorkspacePort {
  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly diagnostics: readonly WorkspaceDiagnostic[] = []
  ) {}

  async listTextFiles(): Promise<readonly string[]> {
    return Object.keys(this.files).sort();
  }

  async listFiles(): Promise<readonly string[]> {
    return this.listTextFiles();
  }

  async globFiles(): Promise<readonly string[]> {
    return this.listTextFiles();
  }

  async readTextFile(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error(`missing ${path}`);
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
    return this.diagnostics;
  }
}
