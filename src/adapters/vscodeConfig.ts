import * as vscode from "vscode";
import { NetworkPolicy, ProviderProfile } from "../core/types";

const sectionName = "codeforge";

export class CodeForgeConfigService {
  private readonly secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  getNetworkPolicy(): NetworkPolicy {
    return {
      allowlist: this.config().get<readonly string[]>("network.allowlist", [])
    };
  }

  getContextLimits(): { readonly maxFiles: number; readonly maxBytes: number } {
    return {
      maxFiles: this.config().get<number>("context.maxFiles", 24),
      maxBytes: this.config().get<number>("context.maxBytes", 120000)
    };
  }

  getCommandTimeoutSeconds(): number {
    return this.config().get<number>("commands.timeoutSeconds", 120);
  }

  getConfiguredModel(): string {
    return this.config().get<string>("model", "").trim();
  }

  async getActiveProfile(): Promise<ProviderProfile> {
    const profiles = this.getProfiles();
    const activeProfileId = this.config().get<string>("activeProfile", "litellm-local");
    const profile = profiles.find((item) => item.id === activeProfileId) ?? profiles[0];
    const apiKey = profile.apiKeySecretName ? await this.secrets.get(secretKey(profile.apiKeySecretName)) : undefined;
    return { ...profile, apiKey };
  }

  getProfiles(): readonly ProviderProfile[] {
    const configured = this.config().get<readonly ProviderProfile[]>("profiles", []);
    return [...defaultProfiles, ...configured].filter(isValidProfile);
  }

  async configureEndpoint(): Promise<void> {
    const preset = await vscode.window.showQuickPick(
      [
        { label: "LiteLLM local", id: "litellm-local", baseUrl: "http://127.0.0.1:4000/v1" },
        { label: "vLLM local", id: "vllm-local", baseUrl: "http://127.0.0.1:8000/v1" },
        { label: "Custom OpenAI-compatible endpoint", id: "custom", baseUrl: "" }
      ],
      { title: "Choose a self-hosted endpoint preset" }
    );
    if (!preset) {
      return;
    }

    const baseUrl = await vscode.window.showInputBox({
      title: "OpenAI-compatible base URL",
      prompt: "Use a /v1 base URL, for example http://127.0.0.1:4000/v1",
      value: preset.baseUrl,
      ignoreFocusOut: true
    });
    if (!baseUrl) {
      return;
    }

    const model = await vscode.window.showInputBox({
      title: "Default model",
      prompt: "Model ID exposed by the endpoint. Leave empty to discover models later.",
      ignoreFocusOut: true
    });

    const apiKey = await vscode.window.showInputBox({
      title: "API key",
      prompt: "Optional. Stored in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true
    });

    const profileId = preset.id === "custom" ? `custom-${Date.now()}` : preset.id;
    const apiKeySecretName = apiKey ? `${profileId}.apiKey` : undefined;
    if (apiKey && apiKeySecretName) {
      await this.secrets.store(secretKey(apiKeySecretName), apiKey);
    }

    const nextProfile: ProviderProfile = {
      id: profileId,
      label: preset.label,
      baseUrl,
      defaultModel: model?.trim() || undefined,
      apiKeySecretName
    };

    const configured = this.config().get<readonly ProviderProfile[]>("profiles", []);
    const withoutPreset = configured.filter((profile) => profile.id !== profileId);
    await this.config().update("profiles", [...withoutPreset, nextProfile], vscode.ConfigurationTarget.Global);
    await this.config().update("activeProfile", profileId, vscode.ConfigurationTarget.Global);
    if (model?.trim()) {
      await this.config().update("model", model.trim(), vscode.ConfigurationTarget.Workspace);
    }
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(sectionName);
  }
}

const defaultProfiles: readonly ProviderProfile[] = [
  {
    id: "litellm-local",
    label: "LiteLLM local",
    baseUrl: "http://127.0.0.1:4000/v1"
  },
  {
    id: "vllm-local",
    label: "vLLM local",
    baseUrl: "http://127.0.0.1:8000/v1"
  }
];

function isValidProfile(profile: ProviderProfile): boolean {
  return Boolean(profile.id && profile.label && profile.baseUrl);
}

function secretKey(name: string): string {
  return `codeforge.profile.${name}`;
}
