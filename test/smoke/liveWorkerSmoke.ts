import { OpenAiCompatibleProvider } from "../../src/core/openaiAdapter";
import { WorkerManager } from "../../src/agent/workerManager";
import {
  AgentAction,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  OpenAiEndpointInspection,
  ProviderCapabilities,
  ProviderProfile,
  WorkspacePort
} from "../../src/core/types";
import { WorkerSummary } from "../../src/core/workerTypes";

// Live multi-agent smoke: drives the real WorkerManager with a real LLM provider and spawns several
// sub-agents at once, proving they run concurrently under the configured cap. The provider is wrapped
// in a counter so we can observe the true in-flight stream count instead of inferring it from timing.
const baseUrl = process.env.CODEFORGE_SMOKE_BASE_URL ?? "http://127.0.0.1:1234";
const model = process.env.CODEFORGE_SMOKE_MODEL ?? "google/gemma-4-31b";
const workerCount = Math.max(1, Number(process.env.CODEFORGE_SMOKE_WORKERS ?? "4"));
const maxConcurrent = Math.max(1, Number(process.env.CODEFORGE_SMOKE_CONCURRENCY ?? "3"));
const overallDeadlineMs = Math.max(30_000, Number(process.env.CODEFORGE_SMOKE_DEADLINE_MS ?? "240000"));

// Each worker gets a self-contained reasoning task so it can finish in a single turn without touching the
// workspace. Distinct prompts keep the model from collapsing them into one cached answer.
const tasks: readonly string[] = [
  "Compute 7 * 8 and state the result.",
  "Name the capital of Japan in one word.",
  "Compute 144 / 12 and state the result.",
  "Give one synonym for 'fast'.",
  "Compute the next prime number after 13.",
  "Name the largest planet in the solar system."
];

class CountingProvider implements LlmProvider {
  readonly profile: ProviderProfile;
  inFlight = 0;
  maxInFlight = 0;
  totalStreams = 0;

  constructor(private readonly inner: OpenAiCompatibleProvider) {
    this.profile = inner.profile;
  }

  async *streamChat(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.inFlight += 1;
    this.totalStreams += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      for await (const event of this.inner.streamChat(request)) {
        yield event;
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  listModels(signal?: AbortSignal): Promise<readonly string[]> {
    return this.inner.listModels(signal);
  }

  inspectEndpoint(signal?: AbortSignal): Promise<OpenAiEndpointInspection> {
    return this.inner.inspectEndpoint(signal);
  }

  probeCapabilities(modelId: string, signal?: AbortSignal): Promise<ProviderCapabilities> {
    return this.inner.probeCapabilities(modelId, signal);
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
    async readTextFile() {
      return "export const value = 1;\n";
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

async function main(): Promise<void> {
  const profile: ProviderProfile = { id: "smoke-profile", label: "Smoke", baseUrl, defaultModel: model };
  const real = new OpenAiCompatibleProvider(
    profile,
    { allowlist: [] },
    { streamCompletionGraceMs: 30_000, streamQuietExtensions: 1 }
  );
  const provider = new CountingProvider(real);

  console.log(`[smoke] endpoint=${baseUrl} model=${model} workers=${workerCount} maxConcurrent=${maxConcurrent}`);

  const seenRunning = new Set<string>();
  const seenDone = new Set<string>();
  const manager = new WorkerManager({
    workspace: fakeWorkspace(),
    contextLimits: () => ({ maxFiles: 8, maxBytes: 32000 }),
    maxConcurrentWorkers: () => maxConcurrent,
    mcpResources: () => [],
    createProvider: async () => provider,
    resolveModel: async () => model,
    capabilities: async () => ({ streaming: true, modelListing: true, nativeToolCalls: false }),
    selectedModelInfo: () => ({ id: model, contextLength: 8192 }),
    requestMaxTokens: () => 512,
    permissionPolicy: () => ({ mode: "smart", rules: [] }),
    // Read-only stub bridge: if a worker decides to call a tool, hand back a harmless result so it can
    // still reach its final summary. The smoke is about parallel orchestration, not tool side effects.
    executeAction: async (action: AgentAction) => `<tool_use_error>tool ${action.type} is stubbed in smoke</tool_use_error>`,
    record: () => undefined,
    onDidChange: (workers: readonly WorkerSummary[]) => {
      for (const worker of workers) {
        if (worker.status === "running" && !seenRunning.has(worker.id)) {
          seenRunning.add(worker.id);
          console.log(`[smoke] -> running ${worker.id} (${worker.kind}) inFlightStreams=${provider.inFlight}`);
        }
        if (worker.status !== "running" && !seenDone.has(worker.id)) {
          seenDone.add(worker.id);
          console.log(`[smoke] <- ${worker.status} ${worker.id}`);
        }
      }
    },
    onNotice: (message: string) => console.log(`[smoke] notice: ${message}`)
  });

  const start = Date.now();
  const spawned = Array.from({ length: workerCount }, (_unused, index) =>
    manager.spawn("explore", tasks[index % tasks.length])
  );
  console.log(`[smoke] spawned ${spawned.length} workers: ${spawned.map((worker) => worker.id).join(", ")}`);

  const ids = spawned.map((worker) => worker.id);
  const deadline = start + overallDeadlineMs;
  while (Date.now() < deadline) {
    const current = manager.list().filter((worker) => ids.includes(worker.id));
    if (current.length === ids.length && current.every((worker) => worker.status !== "running")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const wallMs = Date.now() - start;
  const finals = ids
    .map((id) => manager.list().find((worker) => worker.id === id))
    .filter((worker): worker is WorkerSummary => Boolean(worker));

  console.log("");
  console.log("[smoke] === results ===");
  let perWorkerMsSum = 0;
  for (const worker of finals) {
    const durationMs = (worker.completedAt ?? worker.updatedAt) - worker.startedAt;
    perWorkerMsSum += durationMs;
    const summary = (worker.summary ?? worker.error ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    console.log(
      `[smoke]   ${worker.id} status=${worker.status} ms=${durationMs} tokens=${worker.tokenCount} tools=${worker.toolUseCount} :: ${summary}`
    );
  }

  const completed = finals.filter((worker) => worker.status === "completed").length;
  const stillRunning = finals.filter((worker) => worker.status === "running").length;
  const speedup = wallMs > 0 ? (perWorkerMsSum / wallMs).toFixed(2) : "n/a";

  console.log("");
  console.log(
    `[smoke] observedMaxConcurrentStreams=${provider.maxInFlight} (cap=${maxConcurrent}) totalStreams=${provider.totalStreams}`
  );
  console.log(
    `[smoke] wallClock=${wallMs}ms sumPerWorker=${perWorkerMsSum}ms speedup=${speedup}x completed=${completed}/${finals.length} stillRunning=${stillRunning}`
  );

  if (finals.length !== workerCount) {
    throw new Error(`expected ${workerCount} workers, tracked ${finals.length}`);
  }
  if (stillRunning > 0) {
    throw new Error(`${stillRunning} worker(s) never finished within ${overallDeadlineMs}ms`);
  }
  if (completed === 0) {
    throw new Error("no worker completed successfully");
  }
  if (workerCount > 1 && provider.maxInFlight < 2) {
    throw new Error(`workers did not run in parallel (observedMaxConcurrentStreams=${provider.maxInFlight})`);
  }
  if (provider.maxInFlight > maxConcurrent) {
    throw new Error(`concurrency cap breached: ${provider.maxInFlight} > ${maxConcurrent}`);
  }
  console.log("[smoke] PASS");
}

main().catch((error) => {
  console.error("[smoke] FAIL", error);
  process.exit(1);
});
