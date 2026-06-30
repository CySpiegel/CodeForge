import test from "node:test";
import assert from "node:assert/strict";
import { ModelResolver, ModelResolverDeps } from "../../src/agent/modelResolver";
import { ContextManager, ContextManagerDeps } from "../../src/agent/contextManager";
import { ChatMessage, ContextLimits, ModelInfo, OpenAiEndpointInspection, ProviderProfile } from "../../src/core/types";

// These tests pin the behavior behind the "context window must follow the selected model" fix: when the
// user has not pinned a manual context size, the context budget (and therefore the ring/tooltip and the
// compaction threshold) must track the SELECTED model's contextLength, and a downshift to a smaller
// model must be detectable as needing compaction. They drive the real ModelResolver + ContextManager,
// which are free of any vscode runtime dependency.

const PROFILE: ProviderProfile = { id: "p1", label: "Local", baseUrl: "http://127.0.0.1:8080", defaultModel: "" };

function inspectionWith(models: readonly ModelInfo[]): OpenAiEndpointInspection {
  return { backend: "openai-api", backendLabel: "OpenAI API compatible", models };
}

// maxTokens override BLANK (maxTokens: undefined) is the scenario in the bug report; maxBytes default
// 120000 (= 30000 tokens) is the fallback the system lands on when the model context is unknown.
function makeConfig(overrides: Partial<ContextLimits> = {}): any {
  const limits: ContextLimits = { maxFiles: 24, maxBytes: 120000, maxTokens: undefined, ...overrides };
  return {
    getActiveProfileId: () => PROFILE.id,
    getProfiles: () => [PROFILE],
    getConfiguredModel: () => "",
    getContextLimits: () => limits,
    getMaxOutputTokensPreference: () => undefined,
    getAuxiliaryModel: () => "",
  };
}

function makeResolver(config: any): ModelResolver {
  const deps: ModelResolverDeps = { config, emit: () => {}, recordInspector: () => {} };
  return new ModelResolver(deps);
}

function makeContext(config: any, resolver: ModelResolver, messages: readonly ChatMessage[], approvals = 0): ContextManager {
  const deps: ContextManagerDeps = {
    config,
    getMessages: () => messages,
    replaceMessages: () => {},
    getLastContextItems: () => [],
    getLastTokenUsage: () => undefined,
    selectedModelInfo: () => resolver.selectedModelInfo(),
    resolveAuxiliaryModel: async () => "",
    streamChatWithIdleTimeout: async function* () {},
    systemMessage: () => ({ role: "system", content: "" }),
    approvalsCount: () => approvals,
    emit: () => {},
    publishState: async () => {},
    publishTranscript: async () => {},
  };
  return new ContextManager(deps);
}

test("context window follows the selected model when no manual maxTokens override is set", () => {
  const config = makeConfig();
  const resolver = makeResolver(config);
  resolver.cacheInspection(PROFILE.id, inspectionWith([
    { id: "small-30k", contextLength: 30000 },
    { id: "big-256k", contextLength: 256000 },
  ]));
  const ctx = makeContext(config, resolver, []);

  resolver.setSelectedModel(PROFILE.id, "small-30k");
  assert.equal(ctx.contextWindowMaxTokens(), 30000, "small model should report its own 30k window");

  resolver.setSelectedModel(PROFILE.id, "big-256k");
  assert.equal(ctx.contextWindowMaxTokens(), 256000, "switching to the big model must update the window to 256k");
});

test("a manual maxTokens override still wins over the model's discovered context", () => {
  const config = makeConfig({ maxTokens: 12345 });
  const resolver = makeResolver(config);
  resolver.cacheInspection(PROFILE.id, inspectionWith([{ id: "big-256k", contextLength: 256000 }]));
  const ctx = makeContext(config, resolver, []);

  resolver.setSelectedModel(PROFILE.id, "big-256k");
  assert.equal(ctx.contextWindowMaxTokens(), 12345, "explicit override must take precedence over auto-detection");
});

test("an unknown model context falls back to the default budget (the stale-30k symptom)", () => {
  const config = makeConfig();
  const resolver = makeResolver(config);
  // big-256k has NO contextLength (e.g. a server that only reports context for the loaded model).
  resolver.cacheInspection(PROFILE.id, inspectionWith([
    { id: "small-30k", contextLength: 30000 },
    { id: "big-256k" },
  ]));
  const ctx = makeContext(config, resolver, []);

  resolver.setSelectedModel(PROFILE.id, "big-256k");
  assert.equal(ctx.contextWindowMaxTokens(), undefined, "unknown context yields no token window");
  // contextWindowMaxBytes falls back to the 120000-byte default = 30000 tokens — re-fetching /v1/models
  // on switch is what gives this model a real window when the server can report it.
  assert.equal(ctx.currentUsage().tokens?.maxTokens, 30000, "falls back to the 30k default when context is unknown");
});

test("downshifting to a smaller model flags the context as needing compaction", () => {
  const config = makeConfig();
  const resolver = makeResolver(config);
  resolver.cacheInspection(PROFILE.id, inspectionWith([
    { id: "small-4k", contextLength: 4000 },
    { id: "big-200k", contextLength: 200000 },
  ]));
  // A transcript large enough to fill a 4k window but trivial for a 200k window.
  const transcript: readonly ChatMessage[] = [{ role: "user", content: "x".repeat(40000) }];
  const ctx = makeContext(config, resolver, transcript);

  resolver.setSelectedModel(PROFILE.id, "big-200k");
  assert.equal(ctx.shouldAutoCompact(), false, "the big model has ample room — no compaction needed");

  resolver.setSelectedModel(PROFILE.id, "small-4k");
  assert.equal(ctx.shouldAutoCompact(), true, "downshifting to the small model must request a compaction");
});

test("compaction is not requested while an approval is pending", () => {
  const config = makeConfig();
  const resolver = makeResolver(config);
  resolver.cacheInspection(PROFILE.id, inspectionWith([{ id: "small-4k", contextLength: 4000 }]));
  const transcript: readonly ChatMessage[] = [{ role: "user", content: "x".repeat(40000) }];
  const ctx = makeContext(config, resolver, transcript, 1);

  resolver.setSelectedModel(PROFILE.id, "small-4k");
  assert.equal(ctx.shouldAutoCompact(), false, "a pending approval must defer auto-compaction");
});
