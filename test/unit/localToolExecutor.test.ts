import test from "node:test";
import assert from "node:assert/strict";
import { executeLocalReadOnlyTools } from "../../src/core/localToolExecutor";
import { ContextItem, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../../src/core/types";

test("executes list, glob, read, and grep tools through the workspace port", async () => {
  const workspace = new FakeWorkspace();
  const results = await executeLocalReadOnlyTools(
    [
      { id: "1", source: "json", action: { type: "list_files", limit: 10 } },
      { id: "2", source: "json", action: { type: "glob_files", pattern: "src/**/*.ts", limit: 10 } },
      { id: "3", source: "json", action: { type: "read_file", path: "src/index.ts" } },
      { id: "4", source: "json", action: { type: "grep_text", query: "hello", include: "src/**/*.ts", limit: 10 } },
      { id: "5", source: "json", action: { type: "list_diagnostics", path: "src/index.ts", limit: 10 } }
    ],
    { workspace, readFileMaxBytes: 1000, searchLimit: 20 }
  );

  assert.equal(results.length, 5);
  assert.match(results[0].content, /list_files/);
  assert.match(results[1].content, /src\/index.ts/);
  assert.match(results[2].content, /export const hello/);
  assert.match(results[3].content, /src\/index.ts:1/);
  assert.match(results[4].content, /src\/index.ts:1:14: error/);
});

class FakeWorkspace implements WorkspacePort {
  async listTextFiles(): Promise<readonly string[]> {
    return ["src/index.ts"];
  }

  async listFiles(): Promise<readonly string[]> {
    return ["src/index.ts", "README.md"];
  }

  async globFiles(): Promise<readonly string[]> {
    return ["src/index.ts"];
  }

  async readTextFile(): Promise<string> {
    return "export const hello = 1;\n";
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
    return [{ path: "src/index.ts", line: 1, preview: "export const hello = 1;" }];
  }

  async grepText(): Promise<readonly SearchResult[]> {
    return [{ path: "src/index.ts", line: 1, preview: "export const hello = 1;" }];
  }

  async getDiagnostics(): Promise<readonly WorkspaceDiagnostic[]> {
    return [{ path: "src/index.ts", line: 1, character: 14, severity: "error", message: "Example diagnostic", source: "ts" }];
  }
}
