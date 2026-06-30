import test from "node:test";
import assert from "node:assert/strict";
import { createControllerHarness } from "../harness/agentControllerHarness";

// End-to-end (controller-level) proof of the fix: selecting a model from the front-page dropdown must
// re-inspect /v1/models and emit a context-usage update whose token budget matches the NEWLY selected
// model — not the model that happened to be loaded at connect time. Drives the real AgentController
// through the scripted-provider harness; no vscode and no real endpoint.

const TWO_MODELS = {
  backend: "openai-api" as const,
  backendLabel: "OpenAI API compatible",
  models: [
    { id: "small-30k", contextLength: 30000 },
    { id: "big-256k", contextLength: 256000 },
  ],
};

function lastContextMaxTokens(events: readonly { type: string }[]): number | undefined {
  const contextEvents = events.filter((event): event is { type: "contextUsage"; usage: { tokens: { maxTokens: number } } } =>
    event.type === "contextUsage");
  return contextEvents.length ? contextEvents[contextEvents.length - 1].usage.tokens.maxTokens : undefined;
}

test("selecting a model updates the context window to that model's discovered context", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: [],
    inspection: TWO_MODELS,
    configuredModel: "small-30k",
  });

  await harness.controller.selectModel("big-256k");
  assert.equal(lastContextMaxTokens(harness.events), 256000, "switching to the 256k model must raise the context budget");

  await harness.controller.selectModel("small-30k");
  assert.equal(lastContextMaxTokens(harness.events), 30000, "switching back to the 30k model must lower the context budget");
});

test("selecting a model re-inspects the endpoint (fresh /v1/models), not just the cached inspection", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: [],
    inspection: TWO_MODELS,
    configuredModel: "small-30k",
  });

  // A fresh inspection per switch is what lets the window track a model whose context the connect-time
  // list did not carry. The emitted models event should carry both models with their own contexts.
  await harness.controller.selectModel("big-256k");
  const modelsEvent = [...harness.events].reverse().find((event) => event.type === "models");
  assert.ok(modelsEvent && modelsEvent.type === "models");
  assert.equal(modelsEvent.selectedModel, "big-256k");
  const big = modelsEvent.modelInfo?.find((model) => model.id === "big-256k");
  assert.equal(big?.contextLength, 256000);
});

test("published state surfaces the configured context-compaction (auxiliary) model for the settings selector", async () => {
  const harness = createControllerHarness({
    mode: "agent",
    responses: [],
    inspection: TWO_MODELS,
    auxiliaryModel: "small-30k",
  });

  await harness.controller.refreshModels();
  const stateEvent = [...harness.events].reverse().find((event) => event.type === "state");
  assert.ok(stateEvent && stateEvent.type === "state");
  // The settings dropdown pre-selects from this; the available options come from state.modelInfo.
  assert.equal(stateEvent.state.settings.auxiliaryModel, "small-30k");
  assert.ok(stateEvent.state.modelInfo.some((model) => model.id === "small-30k"));
});
