import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { DoctorCheck } from "../core/doctor";
import { configuredMcpServerStatuses } from "../core/mcpClient";
import { isUrlAllowed } from "../core/networkPolicy";
import { evaluateActionPermission, permissionModeLabel } from "../core/permissions";
import { codeForgeTools } from "../core/toolRegistry";
import { LlmProvider, OpenAiEndpointInspection, ProviderCapabilities, ProviderProfile, WorkspacePort } from "../core/types";
import { errorMessage } from "./toolText";

export interface DoctorServiceDeps {
  readonly config: CodeForgeConfigService;
  readonly workspace: WorkspacePort;
  createProvider(): Promise<LlmProvider>;
  capabilities(provider: LlmProvider, model: string, signal: AbortSignal): Promise<ProviderCapabilities>;
  cacheInspection(profileId: string, inspection: OpenAiEndpointInspection): void;
  selectedModelFor(profile: ProviderProfile, inspection?: OpenAiEndpointInspection): string;
  hasSessionStore(): boolean;
  hasMemoryStore(): boolean;
}

// Builds the /doctor diagnostic report: endpoint reachability + capabilities, workspace access,
// permission mode, MCP config, persistence, and internal tooling. Pure diagnostics — the controller
// owns the run-lifecycle (busy guard, abort, report emission); this service just produces the checks.
export class DoctorService {
  constructor(private readonly deps: DoctorServiceDeps) {}

  async buildChecks(signal: AbortSignal): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      const profile = await this.deps.config.getActiveProfile();
      const networkPolicy = this.deps.config.getNetworkPolicy();
      const endpointPolicy = isUrlAllowed(profile.baseUrl, networkPolicy);
      checks.push({
        category: "Endpoint",
        name: "Network policy",
        status: endpointPolicy.allowed ? "pass" : "fail",
        detail: endpointPolicy.allowed
          ? `${originLabel(profile.baseUrl)} is allowed by the local/offline endpoint policy.`
          : endpointPolicy.reason ?? `${profile.baseUrl} is blocked by the local/offline endpoint policy.`,
        recommendation: endpointPolicy.allowed ? undefined : "Save the endpoint URL in CodeForge settings to allow that exact origin."
      });

      if (endpointPolicy.allowed) {
        await this.addEndpointChecks(checks, signal);
      } else {
        checks.push({
          category: "Endpoint",
          name: "Endpoint inspection",
          status: "fail",
          detail: "Skipped because the active OpenAI API endpoint is blocked by network policy."
        });
      }

      await this.addWorkspaceChecks(checks, signal);
      this.addPermissionChecks(checks);
      this.addMcpChecks(checks);
      this.addPersistenceChecks(checks);
      this.addToolingChecks(checks);
    } catch (error) {
      checks.push({
        category: "Doctor",
        name: "Unexpected error",
        status: "fail",
        detail: errorMessage(error)
      });
    }
    return checks;
  }

  private async addEndpointChecks(checks: DoctorCheck[], signal: AbortSignal): Promise<void> {
    let provider: LlmProvider;
    let inspection: OpenAiEndpointInspection;
    try {
      provider = await this.deps.createProvider();
      inspection = await provider.inspectEndpoint(signal);
      this.deps.cacheInspection(provider.profile.id, inspection);
      checks.push({
        category: "Endpoint",
        name: "Backend detection",
        status: "pass",
        detail: `${inspection.backendLabel} at ${originLabel(provider.profile.baseUrl)}.`
      });
    } catch (error) {
      checks.push({
        category: "Endpoint",
        name: "Endpoint inspection",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Confirm the OpenAI API compatible endpoint is running and reachable from VS Code."
      });
      return;
    }

    checks.push({
      category: "Endpoint",
      name: "Model discovery",
      status: inspection.models.length > 0 ? "pass" : "fail",
      detail: inspection.models.length > 0
        ? `${inspection.models.length} model(s) returned by /v1/models.`
        : "The endpoint returned no models from /v1/models.",
      recommendation: inspection.models.length > 0 ? undefined : "Load a model in the selected OpenAI API compatible server."
    });

    if (inspection.models.length === 0) {
      return;
    }

    const configuredModel = this.deps.config.getConfiguredModel() || provider.profile.defaultModel || "";
    const selectedModel = this.deps.selectedModelFor(provider.profile, inspection);
    const selectedModelInfo = inspection.models.find((model) => model.id === selectedModel);
    const configuredModelFound = !configuredModel || inspection.models.some((model) => model.id === configuredModel);
    checks.push({
      category: "Endpoint",
      name: "Selected model",
      status: selectedModel && configuredModelFound ? "pass" : "warn",
      detail: configuredModelFound
        ? `Using ${selectedModel}.`
        : `Configured model ${configuredModel} was not returned by /v1/models; using ${selectedModel}.`,
      recommendation: configuredModelFound ? undefined : "Select a model returned by the active endpoint."
    });

    checks.push({
      category: "Endpoint",
      name: "Context metadata",
      status: selectedModelInfo?.contextLength ? "pass" : "warn",
      detail: selectedModelInfo?.contextLength
        ? `${selectedModel} reports ${selectedModelInfo.contextLength.toLocaleString("en-US")} context tokens${selectedModelInfo.supportsReasoning ? " and thinking/reasoning support" : ""}.`
        : `${selectedModel} did not expose context length metadata in /v1/models.`,
      recommendation: selectedModelInfo?.contextLength ? undefined : "Expose a context-length field from the OpenAI API compatible endpoint when possible — e.g. max_model_len (vLLM), n_ctx or n_ctx_train (llama.cpp, under meta), context_length (OpenRouter/Together), context_window (Groq), max_context_length (LM Studio/Mistral), or max_input_tokens/max_tokens (LiteLLM). CodeForge detects any of these, at the top level or nested."
    });

    try {
      const capabilities = await this.deps.capabilities(provider, selectedModel, signal);
      checks.push({
        category: "Endpoint",
        name: "Native tool calls",
        status: capabilities.nativeToolCalls ? "pass" : "warn",
        detail: capabilities.nativeToolCalls
          ? `${selectedModel} accepted OpenAI-style tool calls.`
          : `${selectedModel} did not accept native tool calls; CodeForge will use JSON action fallback.`,
        recommendation: capabilities.nativeToolCalls ? undefined : "Use a model/server combination with OpenAI tool-call support for the most reliable agent loop."
      });
      checks.push({
        category: "Endpoint",
        name: "Streaming",
        status: capabilities.streaming ? "pass" : "warn",
        detail: capabilities.streaming ? "Streaming chat responses are available." : "Streaming responses were not confirmed."
      });
    } catch (error) {
      checks.push({
        category: "Endpoint",
        name: "Capability probe",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Check that /v1/chat/completions accepts the selected model and OpenAI-compatible request bodies."
      });
    }
  }

  private async addWorkspaceChecks(checks: DoctorCheck[], signal: AbortSignal): Promise<void> {
    try {
      const files = await this.deps.workspace.listTextFiles(5, signal);
      checks.push({
        category: "Repo Folder",
        name: "File discovery",
        status: files.length > 0 ? "pass" : "warn",
        detail: files.length > 0
          ? `Repo search can see files including ${files.slice(0, 3).join(", ")}.`
          : "No repo text files were returned.",
        recommendation: files.length > 0 ? undefined : "Open the repo folder before asking CodeForge to inspect code."
      });
    } catch (error) {
      checks.push({
        category: "Repo Folder",
        name: "File discovery",
        status: "fail",
        detail: errorMessage(error),
        recommendation: "Check VS Code trust and filesystem access for the open repo folder."
      });
    }
  }

  private addPermissionChecks(checks: DoctorCheck[]): void {
    const policy = this.deps.config.getPermissionPolicy();
    const readDecision = evaluateActionPermission({ type: "read_file", path: "README.md" }, policy);
    const writeDecision = evaluateActionPermission({ type: "write_file", path: "codeforge-doctor.txt", content: "diagnostic\n" }, policy);
    const commandDecision = evaluateActionPermission({ type: "run_command", command: "npm test" }, policy);
    checks.push({
      category: "Permissions",
      name: "Approval mode",
      status: readDecision.behavior === "deny" ? "fail" : "pass",
      detail: `${permissionModeLabel(policy.mode)} mode: read_file=${readDecision.behavior}, write_file=${writeDecision.behavior}, run_command=${commandDecision.behavior}.`,
      recommendation: readDecision.behavior === "deny" ? "Remove deny rules that block read_file if the model should understand the codebase." : undefined
    });
  }

  private addMcpChecks(checks: DoctorCheck[]): void {
    const statuses = configuredMcpServerStatuses(this.deps.config.getMcpServers(), this.deps.config.getNetworkPolicy());
    if (statuses.length === 0) {
      checks.push({
        category: "MCP",
        name: "Configured servers",
        status: "pass",
        detail: "No MCP servers configured. MCP is optional and only uses explicitly configured servers."
      });
      return;
    }

    for (const status of statuses) {
      checks.push({
        category: "MCP",
        name: status.label,
        status: !status.enabled || status.valid ? "pass" : "fail",
        detail: status.enabled
          ? status.valid
            ? `${status.transport} ${status.target} is configured.`
            : status.reason ?? `${status.transport} ${status.target} is invalid.`
          : `${status.transport} ${status.target} is disabled.`,
        recommendation: status.enabled && !status.valid ? "Fix or remove this MCP server configuration." : undefined
      });
    }
  }

  private addPersistenceChecks(checks: DoctorCheck[]): void {
    checks.push({
      category: "Persistence",
      name: "Repo chat history",
      status: this.deps.hasSessionStore() ? "pass" : "warn",
      detail: this.deps.hasSessionStore() ? "Repo-scoped chat sessions are available." : "Session storage is not available in this environment."
    });
    checks.push({
      category: "Persistence",
      name: "Local memory",
      status: this.deps.hasMemoryStore() ? "pass" : "warn",
      detail: this.deps.hasMemoryStore() ? "Persistent local memory is available." : "Persistent local memory is not available in this environment."
    });
  }

  private addToolingChecks(checks: DoctorCheck[]): void {
    checks.push({
      category: "Tooling",
      name: "Internal tools",
      status: "pass",
      detail: `${codeForgeTools.length} internal tools are registered with deferred schema loading via tool_search.`
    });
  }
}

function originLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl;
  }
}
