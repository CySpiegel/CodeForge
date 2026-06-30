import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { EndpointCapabilityStore, isFreshCapability } from "../core/endpointCapabilityCache";
import { AnthropicMessagesProvider } from "../core/anthropicAdapter";
import { OpenAiCompatibleProvider } from "../core/openaiAdapter";
import { resolveProviderKind } from "../core/providerKind";
import { LlmProvider, OpenAiEndpointInspection, ProviderCapabilities } from "../core/types";
import type { AgentCapabilitySummary, AgentInspectorEntry } from "./agentUiTypes";

export interface ProviderGatewayDeps {
  readonly config: CodeForgeConfigService;
  readonly providerFactory: (() => LlmProvider | Promise<LlmProvider>) | undefined;
  readonly endpointCapabilityStore: EndpointCapabilityStore | undefined;
  getInspection(profileId: string): OpenAiEndpointInspection | undefined;
  recordInspector(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void;
}

// Owns talking to the configured endpoint: provider construction and the per-(profile,model) capability
// probe + cache (in-memory plus the persisted EndpointCapabilityStore). The run engine, workers,
// learning loop, and doctor all go through this gateway so capability probing happens once per model.
export class ProviderGateway {
  private readonly capabilityCache = new Map<string, ProviderCapabilities>();

  constructor(private readonly deps: ProviderGatewayDeps) {}

  async createProvider(): Promise<LlmProvider> {
    if (this.deps.providerFactory) {
      return this.deps.providerFactory();
    }
    const profile = await this.deps.config.getActiveProfile();
    const policy = this.deps.config.getNetworkPolicy();
    const options = {
      streamCompletionGraceMs: this.deps.config.getStreamCompletionGraceSeconds() * 1000,
      maxRateLimitRetries: this.deps.config.getRateLimitRetries()
    };
    // The protocol is inferred from the base URL host: an api.anthropic.com (or *.anthropic.com)
    // endpoint speaks the native Messages API, everything else the OpenAI-compatible API.
    return resolveProviderKind(profile.baseUrl) === "anthropic"
      ? new AnthropicMessagesProvider(profile, policy, options)
      : new OpenAiCompatibleProvider(profile, policy, options);
  }

  async capabilities(provider: LlmProvider, model: string, signal: AbortSignal): Promise<ProviderCapabilities> {
    const key = `${provider.profile.id}:${model}`;
    const cached = this.capabilityCache.get(key);
    if (cached) {
      return cached;
    }

    const persisted = await this.deps.endpointCapabilityStore?.get(provider.profile.id, provider.profile.baseUrl, model);
    if (persisted && isFreshCapability(persisted)) {
      this.capabilityCache.set(key, persisted.capabilities);
      this.deps.recordInspector("info", "endpoint", `Loaded cached capabilities for ${model}.`, `Native tools: ${persisted.capabilities.nativeToolCalls ? "yes" : "no"}\nStreaming: ${persisted.capabilities.streaming ? "yes" : "no"}`);
      return persisted.capabilities;
    }

    const capabilities = await provider.probeCapabilities(model, signal);
    this.capabilityCache.set(key, capabilities);
    const inspection = this.deps.getInspection(provider.profile.id);
    void this.deps.endpointCapabilityStore?.upsert({
      profileId: provider.profile.id,
      baseUrl: provider.profile.baseUrl,
      model,
      backendLabel: inspection?.backendLabel,
      modelInfo: inspection?.models.find((item) => item.id === model),
      capabilities,
      checkedAt: Date.now()
    });
    this.deps.recordInspector("info", "endpoint", `Probed capabilities for ${model}.`, `Native tools: ${capabilities.nativeToolCalls ? "yes" : "no"}\nStreaming: ${capabilities.streaming ? "yes" : "no"}`);
    return capabilities;
  }

  async capabilitySummaries(profileId: string): Promise<readonly AgentCapabilitySummary[]> {
    const entries = await this.deps.endpointCapabilityStore?.list(profileId).catch(() => []) ?? [];
    return entries.slice(0, 20).map((entry) => ({
      profileId: entry.profileId,
      baseUrl: entry.baseUrl,
      model: entry.model,
      backendLabel: entry.backendLabel,
      nativeToolCalls: entry.capabilities.nativeToolCalls,
      streaming: entry.capabilities.streaming,
      modelListing: entry.capabilities.modelListing,
      contextLength: entry.modelInfo?.contextLength,
      supportsReasoning: entry.modelInfo?.supportsReasoning,
      checkedAt: entry.checkedAt
    }));
  }
}
