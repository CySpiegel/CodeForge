import test from "node:test";
import assert from "node:assert/strict";
import { WorkerManager } from "../../src/agent/workerManager";
import { LlmProvider, LlmRequest, LlmStreamEvent, PermissionPolicy, ProviderCapabilities, ProviderProfile, WorkspacePort } from "../../src/core/types";
import { WorkerSummary } from "../../src/core/workerTypes";

type ExecuteWorkerAction = ConstructorParameters<typeof WorkerManager>[0]["executeAction"];

test("worker manager runs read-only tools and completes with a transcript", async () => {
  const manager = createWorkerManager([
    JSON.stringify({ actions: [{ type: "read_file", path: "src/a.ts", reason: "inspect" }] }),
    "Scope: inspect src/a.ts\nResult: read the file\nKey files: src/a.ts\nFiles changed: none\nIssues: none\nConfidence: high"
  ]);

  const worker = manager.spawn("explore", "inspect src/a.ts");
  const completed = await waitForWorker(manager, worker.id, "completed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(completed.status, "completed");
  assert.equal(completed.filesInspected.includes("src/a.ts"), true);
  assert.match(output, /read_file src\/a\.ts/);
  assert.match(output, /Files changed: none/);
});

test("worker manager blocks write actions inside read-only workers", async () => {
  const manager = createWorkerManager([
    JSON.stringify({ actions: [{ type: "write_file", path: "src/a.ts", content: "changed" }] })
  ]);

  const worker = manager.spawn("review", "try to write");
  const failed = await waitForWorker(manager, worker.id, "failed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(failed.status, "failed");
  assert.match(output, /cannot use write_file/);
});

test("worker manager dispatches approval-gated edits for implementation workers", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({ actions: [{ type: "write_file", path: "src/a.ts", content: "export const value = 2;\n", reason: "update value" }] }),
      "Scope: src/a.ts\nResult: changed value\nKey files: src/a.ts\nFiles changed: src/a.ts\nIssues: none\nConfidence: high"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return action.type === "write_file" ? `write_file ${action.path}\n\nWrote ${action.path}.` : "ok";
    }
  );

  const worker = manager.spawn("implement", "change value");
  const completed = await waitForWorker(manager, worker.id, "completed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["write_file"]);
  assert.match(output, /write_file src\/a\.ts/);
  assert.match(output, /Files changed: src\/a\.ts/);
});

test("verify worker can dispatch approval-gated commands", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({ actions: [{ type: "run_command", command: "npm test", cwd: ".", reason: "verify" }] }),
      "Scope: tests\nResult: command passed\nKey files: package.json\nFiles changed: none\nIssues: none\nConfidence: high\nVERDICT: PASS"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return action.type === "run_command" ? "run_command npm test\n\nStatus: exited with 0" : "ok";
    }
  );

  const worker = manager.spawn("verify", "run tests");
  const completed = await waitForWorker(manager, worker.id, "completed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["run_command"]);
  assert.match(output, /run_command npm test/);
  assert.match(output, /VERDICT: PASS/);
});

test("implementation worker can dispatch internal task state tools", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({ actions: [{ type: "task_create", subject: "Inspect auth", reason: "track work" }] }),
      "Scope: auth\nResult: task tracked\nKey files: none\nFiles changed: none\nIssues: none\nConfidence: high"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return "task_create task-1-abc\n\nID: task-1-abc\nStatus: pending\nSubject: Inspect auth";
    }
  );

  const worker = manager.spawn("implement", "track implementation");
  const completed = await waitForWorker(manager, worker.id, "completed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["task_create"]);
  assert.match(output, /task_create task-1-abc/);
});

test("explore worker can use code intelligence tools", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({ actions: [{ type: "code_symbols", path: "src/a.ts", reason: "inspect symbols" }] }),
      "Scope: src/a.ts\nResult: symbols inspected\nKey files: src/a.ts\nFiles changed: none\nIssues: none\nConfidence: high"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return "code_symbols src/a.ts\n\nvalue (Constant) 1:14";
    }
  );

  const worker = manager.spawn("explore", "inspect symbols");
  const completed = await waitForWorker(manager, worker.id, "completed");

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["code_symbols"]);
});

test("review worker cannot ask user questions", async () => {
  const manager = createWorkerManager([
    JSON.stringify({
      actions: [{
        type: "ask_user_question",
        questions: [{
          question: "Which path?",
          header: "Path",
          options: [
            { label: "A", description: "Path A" },
            { label: "B", description: "Path B" }
          ]
        }]
      }]
    })
  ]);

  const worker = manager.spawn("review", "ask a question");
  const failed = await waitForWorker(manager, worker.id, "failed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(failed.status, "failed");
  assert.match(output, /cannot use ask_user_question/);
});

test("implementation worker can ask user questions through the parent bridge", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({
        actions: [{
          type: "ask_user_question",
          questions: [{
            question: "Which path?",
            header: "Path",
            options: [
              { label: "A", description: "Path A" },
              { label: "B", description: "Path B" }
            ]
          }]
        }]
      }),
      "Scope: question\nResult: answer used\nKey files: none\nFiles changed: none\nIssues: none\nConfidence: high"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return "ask_user_question\n\nUser answered CodeForge's question(s):\n- Which path? -> A";
    }
  );

  const worker = manager.spawn("implement", "ask user");
  const completed = await waitForWorker(manager, worker.id, "completed");

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["ask_user_question"]);
});

test("implementation worker can dispatch approval-gated notebook edits", async () => {
  const actions: string[] = [];
  const manager = createWorkerManager(
    [
      JSON.stringify({ actions: [{ type: "notebook_edit_cell", path: "notebooks/demo.ipynb", index: 0, content: "print('hi')", language: "python", kind: "code", reason: "update notebook" }] }),
      "Scope: notebooks/demo.ipynb\nResult: notebook updated\nKey files: notebooks/demo.ipynb\nFiles changed: notebooks/demo.ipynb\nIssues: none\nConfidence: high"
    ],
    { mode: "smart", rules: [] },
    async (action) => {
      actions.push(action.type);
      return "notebook_edit_cell notebooks/demo.ipynb:0\n\nUpdated cell 0.";
    }
  );

  const worker = manager.spawn("implement", "update notebook");
  const completed = await waitForWorker(manager, worker.id, "completed");

  assert.equal(completed.status, "completed");
  assert.deepEqual(actions, ["notebook_edit_cell"]);
});

test("worker manager applies parent permission policy to read-only actions", async () => {
  const manager = createWorkerManager(
    [JSON.stringify({ actions: [{ type: "read_file", path: "secrets.txt" }] })],
    { mode: "smart", rules: [{ kind: "path", pattern: "secrets.txt", behavior: "deny", scope: "workspace" }] }
  );

  const worker = manager.spawn("explore", "inspect secrets");
  const failed = await waitForWorker(manager, worker.id, "failed");
  const output = manager.output(worker.id) ?? "";

  assert.equal(failed.status, "failed");
  assert.match(output, /parent permission policy/);
});

function createWorkerManager(
  responses: readonly string[],
  permissionPolicy: PermissionPolicy = { mode: "smart", rules: [] },
  executeAction: ExecuteWorkerAction = async () => "<tool_use_error>Error: no worker side-effect bridge configured</tool_use_error>"
): WorkerManager {
  const provider = new FakeProvider(responses);
  return new WorkerManager({
    workspace: fakeWorkspace(),
    contextLimits: () => ({ maxFiles: 8, maxBytes: 32000 }),
    memories: async () => [],
    mcpResources: () => [],
    createProvider: async () => provider,
    resolveModel: async () => "local-model",
    capabilities: async () => ({ streaming: true, modelListing: true, nativeToolCalls: false }),
    selectedModelInfo: () => ({ id: "local-model", contextLength: 8192 }),
    permissionPolicy: () => permissionPolicy,
    executeAction,
    record: () => undefined,
    onDidChange: () => undefined,
    onNotice: () => undefined
  });
}

async function waitForWorker(manager: WorkerManager, id: string, status: WorkerSummary["status"]): Promise<WorkerSummary> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const worker = manager.list().find((item) => item.id === id);
    if (worker?.status === status) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker ${id} did not reach ${status}. Current workers: ${JSON.stringify(manager.list())}`);
}

class FakeProvider implements LlmProvider {
  readonly profile: ProviderProfile = {
    id: "local",
    label: "Local OpenAI API",
    baseUrl: "http://127.0.0.1:1234"
  };
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async *streamChat(_request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const text = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "";
    this.index++;
    yield { type: "content", text };
    yield { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
    yield { type: "done" };
  }

  async listModels(): Promise<readonly string[]> {
    return ["local-model"];
  }

  async inspectEndpoint() {
    return {
      backend: "openai-api" as const,
      backendLabel: "OpenAI API compatible",
      models: [{ id: "local-model" }]
    };
  }

  async probeCapabilities(): Promise<ProviderCapabilities> {
    return { streaming: true, modelListing: true, nativeToolCalls: false };
  }
}

function fakeWorkspace(): WorkspacePort {
  return {
    async listTextFiles() {
      return ["src/a.ts", "package.json"];
    },
    async listFiles() {
      return ["src/a.ts", "package.json"];
    },
    async globFiles() {
      return ["src/a.ts"];
    },
    async readTextFile(path) {
      if (path === "src/a.ts") {
        return "export const value = 1;\n";
      }
      if (path === "secrets.txt") {
        return "secret\n";
      }
      throw new Error("not found");
    },
    async getActiveTextDocument() {
      return undefined;
    },
    async getOpenTextDocuments() {
      return [];
    },
    async getActiveSelection() {
      return undefined;
    },
    async searchText() {
      return [];
    },
    async grepText() {
      return [];
    },
    async getDiagnostics() {
      return [];
    }
  };
}
