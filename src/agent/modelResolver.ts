import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { LlmProvider, ModelInfo, OpenAiEndpointInspection, ProviderProfile } from "../core/types";
import type { AgentUiEvent } from "./agentController";

export interface ModelResolverDeps {
  readonly config: CodeForgeConfigService;
  emit(event: AgentUiEvent): void;
  recordInspector(level: "info" | "warn" | "error", category: string, summary: string, detail?: string): void;
}

interface ModelIdResolution {
  readonly id: string;
  // True when a NON-EMPTY configured id was provided but matched no returned model id/alias.
  readonly unmatched: boolean;
}

// Owns endpoint model discovery results and which model is selected per profile, plus the logic that
// picks the model to send and warns when a selection is unavailable. The controller (refreshModels,
// doctor, getState) reads/writes the cache through the accessors below; everything else goes through
// the resolve* methods.
export class ModelResolver {
  private readonly endpointCache = new Map<string, OpenAiEndpointInspection>();
  private readonly selectedModelByProfile = new Map<string, string>();
  // Dedup keys (`${profileId}:${configuredId}`) for the one-time "configured model not in list" warning.
  private readonly warnedUnmatchedModels = new Set<string>();
  // Dedup keys (`${profileId}:${selectedId}`) for the visible "selected model is currently unavailable"
  // chat notice. Cleared for a model once it is seen available again so a later disappearance re-warns.
  private readonly unavailableModelNoticed = new Set<string>();

  constructor(private readonly deps: ModelResolverDeps) {}

  // -- Cache accessors (used by refreshModels / doctor / getState / capabilities) ----------------

  cacheInspection(profileId: string, inspection: OpenAiEndpointInspection): void {
    this.endpointCache.set(profileId, inspection);
  }

  getInspection(profileId: string): OpenAiEndpointInspection | undefined {
    return this.endpointCache.get(profileId);
  }

  setSelectedModel(profileId: string, model: string): void {
    this.selectedModelByProfile.set(profileId, model);
  }

  // Seed the per-profile selection from a resolved id only if nothing is selected yet, so the dropdown
  // and request agree from the first turn without overriding an explicit user choice.
  seedSelectedModel(profileId: string, model: string): void {
    if (model && !this.selectedModelByProfile.has(profileId)) {
      this.selectedModelByProfile.set(profileId, model);
    }
  }

  // -- Resolution -------------------------------------------------------------------------------

  async resolveModel(provider: LlmProvider, signal: AbortSignal): Promise<string> {
    const cachedInspection = this.endpointCache.get(provider.profile.id);
    if (cachedInspection) {
      const configured = this.selectedModelFor(provider.profile, cachedInspection);
      if (configured) {
        return configured;
      }
    }

    let inspection: OpenAiEndpointInspection;
    try {
      inspection = await provider.inspectEndpoint(signal);
    } catch (error) {
      const configured = this.selectedModelFor(provider.profile);
      if (configured) {
        return configured;
      }
      throw error;
    }
    this.endpointCache.set(provider.profile.id, inspection);
    if (inspection.models.length === 0) {
      throw new Error("No model is configured and the endpoint did not return any models.");
    }
    this.notifyIfSelectedModelUnavailable(provider.profile, inspection);
    return this.selectedModelFor(provider.profile, inspection);
  }

  // Resolve the model for one of CodeForge's own utility turns (compaction / learning review /
  // curator). Uses codeforge.model.auxiliary when it is set AND actually served by the endpoint;
  // otherwise falls back to the provided main model, or resolves the selected model.
  async resolveAuxiliaryModel(provider: LlmProvider, signal: AbortSignal, fallbackModel?: string): Promise<string> {
    const aux = this.deps.config.getAuxiliaryModel();
    const fallback = async (): Promise<string> => fallbackModel ?? this.resolveModel(provider, signal);
    if (!aux) {
      return fallback();
    }
    let inspection = this.endpointCache.get(provider.profile.id);
    if (!inspection) {
      inspection = await provider.inspectEndpoint(signal).catch(() => undefined);
      if (inspection) {
        this.endpointCache.set(provider.profile.id, inspection);
      }
    }
    if (!inspection) {
      return fallback();
    }
    const needle = aux.toLowerCase();
    const available = inspection.models.some((model) =>
      model.id.trim().toLowerCase() === needle
      || (model.aliases ?? []).some((alias) => alias.trim().toLowerCase() === needle)
    );
    return available ? aux : fallback();
  }

  selectedModelInfo(): ModelInfo | undefined {
    const activeProfileId = this.deps.config.getActiveProfileId();
    const inspection = this.endpointCache.get(activeProfileId);
    if (!inspection) {
      return undefined;
    }

    const profile = this.deps.config.getProfiles().find((item) => item.id === activeProfileId);
    const selectedModel = profile ? this.selectedModelFor(profile, inspection) : inspection.models[0]?.id || "";
    return inspection.models.find((model) => model.id === selectedModel);
  }

  selectedModelFor(profile: ProviderProfile, inspection?: OpenAiEndpointInspection): string {
    const selected = this.selectedModelByProfile.get(profile.id);
    if (selected) {
      return selected;
    }

    const configured = this.deps.config.getConfiguredModel() || profile.defaultModel || "";
    const resolution = resolveConfiguredModelId(configured, inspection?.models ?? []);
    if (resolution.unmatched) {
      this.warnUnmatchedConfiguredModel(profile, resolution.id);
    }
    return resolution.id;
  }

  // Surfaces a single, deduplicated warning when a non-empty configured model id is not present in
  // the endpoint's model list. We deliberately keep the configured id (see resolveConfiguredModelId)
  // rather than silently swapping to models[0], so the model the user intends is the model sent.
  private warnUnmatchedConfiguredModel(profile: ProviderProfile, configured: string): void {
    const key = `${profile.id}:${configured}`;
    if (this.warnedUnmatchedModels.has(key)) {
      return;
    }
    this.warnedUnmatchedModels.add(key);
    this.deps.recordInspector(
      "warn",
      "endpoint",
      `Configured model "${configured}" was not found in the endpoint's model list.`,
      "Sending the configured id anyway. Single-model servers (e.g. llama.cpp) ignore the requested id and serve their loaded model. If this is wrong, pick a model from the dropdown."
    );
  }

  // Emit a one-time, visible chat notice when the model the user has selected is not actually served
  // by the endpoint, so a stale or removed selection does not silently fail. Stays quiet for a
  // single-model server (generic openai-api with one model), which serves its loaded model regardless
  // of the requested id; routers like LiteLLM/vLLM reject unknown ids, so they always warn.
  notifyIfSelectedModelUnavailable(profile: ProviderProfile, inspection: OpenAiEndpointInspection): void {
    if (inspection.models.length === 0) {
      return;
    }
    const selected = this.selectedModelFor(profile, inspection);
    if (!selected) {
      return;
    }
    const needle = selected.trim().toLowerCase();
    const available = inspection.models.some((model) =>
      model.id.trim().toLowerCase() === needle
      || (model.aliases ?? []).some((alias) => alias.trim().toLowerCase() === needle)
    );
    const key = `${profile.id}:${selected}`;
    if (available) {
      // Re-arm the notice so a later disappearance of this model warns again.
      this.unavailableModelNoticed.delete(key);
      return;
    }
    const isRouter = inspection.backend === "litellm" || inspection.backend === "vllm";
    if (inspection.models.length === 1 && !isRouter) {
      return;
    }
    if (this.unavailableModelNoticed.has(key)) {
      return;
    }
    this.unavailableModelNoticed.add(key);
    this.deps.emit({
      type: "message",
      role: "system",
      text: `⚠️ The selected model “${selected}” is currently unavailable — ${profile.label} did not return it from /v1/models. Pick an available model from the dropdown to continue.`
    });
  }
}

// Pure, dependency-free resolution of a configured/persisted model id against the endpoint's returned
// models. Exported for unit testing.
//
// Rules:
// 1. Empty configured id with a model list -> fall back to models[0] (preserves prior behavior; lets
//    single-model servers "just work" when nothing is configured).
// 2. Non-empty configured id -> match tolerantly against each model's canonical id AND its aliases,
//    trimmed and case-insensitively, returning the CANONICAL returned id on a match.
// 3. Non-empty configured id that matches nothing -> KEEP the configured id (do NOT swap to models[0])
//    and flag it unmatched so the caller can warn once.
export function resolveConfiguredModelId(configured: string, models: readonly ModelInfo[]): ModelIdResolution {
  const trimmed = configured.trim();
  if (!trimmed) {
    return { id: models[0]?.id ?? "", unmatched: false };
  }
  const needle = trimmed.toLowerCase();
  for (const model of models) {
    if (model.id.trim().toLowerCase() === needle) {
      return { id: model.id, unmatched: false };
    }
    for (const alias of model.aliases ?? []) {
      if (alias.trim().toLowerCase() === needle) {
        return { id: model.id, unmatched: false };
      }
    }
  }
  return { id: trimmed, unmatched: models.length > 0 };
}
