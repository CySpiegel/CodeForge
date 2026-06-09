import test from "node:test";
import assert from "node:assert/strict";
import { HolographicStore } from "../../src/core/holographic/store";
import { HolographicRetriever } from "../../src/core/holographic/retrieval";
import { HolographicMemoryProvider } from "../../src/core/holographic/holographicProvider";
import { BinaryStore } from "../../src/core/holographic/sqlite";

function fakeBinaryStore(): BinaryStore & { value: () => Uint8Array | undefined } {
  let bytes: Uint8Array | undefined;
  return {
    value: () => bytes,
    async load() {
      return bytes;
    },
    async save(b) {
      bytes = new Uint8Array(b);
    }
  };
}

let clock = 0;
const now = () => ++clock;

test("SQLite store: add, dedupe, hybrid search, persist + reload", async () => {
  clock = 0;
  const persistence = fakeBinaryStore();
  const store = new HolographicStore(persistence, now);
  await store.load();
  await store.addFact("Use esbuild to bundle the extension", "workspace", ["esbuild"]);
  await store.addFact("Run tests with node --test", "workspace");
  await store.addFact("Use esbuild to bundle the extension", "workspace"); // duplicate
  assert.equal(store.size, 2);

  const hits = new HolographicRetriever(store).search("how do we bundle with esbuild");
  assert.ok(hits.length >= 1);
  assert.match(hits[0].fact.content, /esbuild/);

  // Reload from the persisted SQLite bytes.
  const reloaded = new HolographicStore(persistence, now);
  await reloaded.load();
  assert.equal(reloaded.size, 2);
  assert.match(new HolographicRetriever(reloaded).search("esbuild bundle")[0].fact.content, /esbuild/);
});

test("trust feedback adjusts and clamps", async () => {
  clock = 0;
  const store = new HolographicStore(fakeBinaryStore(), now);
  await store.load();
  const fact = await store.addFact("CI deploys from main", "ops");
  assert.ok(fact);
  assert.equal(fact!.trust, 0.5);
  await store.recordFeedback(fact!.id, false);
  assert.ok(Math.abs(store.getFact(fact!.id)!.trust - 0.4) < 1e-9);
  await store.recordFeedback(fact!.id, true);
  assert.ok(Math.abs(store.getFact(fact!.id)!.trust - 0.45) < 1e-9);
  for (let i = 0; i < 10; i++) {
    await store.recordFeedback(fact!.id, false);
  }
  assert.equal(store.getFact(fact!.id)!.trust, 0);
});

test("compositional reason + contradict run over the entity graph", async () => {
  clock = 0;
  const store = new HolographicStore(fakeBinaryStore(), now);
  await store.load();
  await store.addFact("Postgres is the primary production database", "arch");
  await store.addFact("Postgres should never be used in this project", "arch");
  await store.addFact("Postgres and Redis are both used in production", "arch");
  const retriever = new HolographicRetriever(store);

  // Two facts share the entity "Postgres" but disagree → a contradiction pair.
  const pairs = retriever.contradict();
  assert.ok(pairs.length >= 1, "expected at least one contradiction over shared entities");

  // reason about both entities should return results (AND over entities).
  const reasoned = retriever.reason(["postgres", "redis"]);
  assert.ok(reasoned.length >= 1);
});

test("provider exposes fact_store + fact_feedback and recalls via prefetch", async () => {
  clock = 0;
  const provider = new HolographicMemoryProvider(fakeBinaryStore());
  await provider.initialize({ sessionId: "s1" });
  assert.deepEqual(provider.getToolSchemas().map((s) => s.name), ["fact_store", "fact_feedback"]);

  const saved = JSON.parse(await provider.handleToolCall("fact_store", { action: "save", content: "The API base url is set per profile", category: "workspace" }));
  assert.equal(saved.success, true);

  const searched = JSON.parse(await provider.handleToolCall("fact_store", { action: "search", query: "where is the api base url configured" }));
  assert.equal(searched.success, true);
  assert.ok(searched.facts.length >= 1);
  assert.match(searched.facts[0].content, /API base url/);

  const feedback = JSON.parse(await provider.handleToolCall("fact_feedback", { id: saved.id, helpful: true }));
  assert.equal(feedback.success, true);

  // onMemoryWrite mirrors curated-memory adds into the durable store.
  provider.onMemoryWrite("add", "user", "User prefers dark mode");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recall = await provider.prefetch("what theme does the user like");
  assert.match(recall, /dark mode/);
});
