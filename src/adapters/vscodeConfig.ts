import * as vscode from "vscode";
import { allowlistEntryForUrl, assertUrlAllowed, isUrlAllowed } from "../core/networkPolicy";
import { normalizePermissionPolicy, parsePermissionRules } from "../core/permissions";
import { normalizeSettingsPermissionMode } from "../core/settingsMigration";
import { AgentMode, ContextLimits, McpServerConfig, NetworkPolicy, PermissionMode, PermissionPolicy, PermissionRule, ProviderProfile } from "../core/types";

const sectionName = "codeforge";

export class CodeForgeConfigService {
  private readonly secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  getNetworkPolicy(): NetworkPolicy {
    const configuredAllowlist = this.config().get<readonly string[]>("network.allowlist", []);
    const profileOrigins = this.getProfiles()
      .map((profile) => allowlistEntryForUrl(profile.baseUrl))
      .filter((entry): entry is string => entry !== undefined);
    return {
      allowlist: normalizeAllowlist([...configuredAllowlist, ...profileOrigins])
    };
  }

  getMcpServers(): readonly McpServerConfig[] {
    return normalizeMcpServerConfigs(this.config().get<readonly unknown[]>("mcp.servers", []));
  }

  getContextLimits(): ContextLimits {
    const maxTokens = clampNumber(this.config().get<number>("context.maxTokens", 0), 0, 10_000_000, 0);
    return {
      maxFiles: clampNumber(this.config().get<number>("context.maxFiles", 24), 1, 200, 24),
      maxBytes: clampNumber(this.config().get<number>("context.maxBytes", 120000), 8000, 2_000_000, 120000),
      maxTokens: maxTokens > 0 ? maxTokens : undefined
    };
  }

  getCommandTimeoutSeconds(): number {
    return clampNumber(this.config().get<number>("commands.timeoutSeconds", 120), 5, 1800, 120);
  }

  getCommandOutputLimitBytes(): number {
    return clampNumber(this.config().get<number>("commands.outputLimitBytes", 200000), 16000, 2_000_000, 200000);
  }

  getPermissionPolicy(): PermissionPolicy {
    const mode = normalizeSettingsPermissionMode(this.config().get<unknown>("permissions.mode", "smart"));
    const rules = parsePermissionRules(this.config().get<readonly unknown[]>("permissions.rules", []), "workspace");
    return normalizePermissionPolicy({ mode, rules });
  }

  getAgentMode(): AgentMode {
    const mode = this.config().get<AgentMode | "auto">("agent.mode", "agent");
    if (mode === "auto") {
      return "agent";
    }
    return isAgentMode(mode) ? mode : "agent";
  }

  getConfiguredModel(): string {
    return this.config().get<string>("model", "").trim();
  }

  getActiveProfileId(): string {
    return this.config().get<string>("activeProfile", "openai-api-local");
  }

  async getActiveProfile(): Promise<ProviderProfile> {
    const profiles = this.getProfiles();
    const activeProfileId = this.getActiveProfileId();
    const profile = profiles.find((item) => item.id === activeProfileId) ?? profiles[0];
    const apiKey = profile.apiKeySecretName ? await this.secrets.get(secretKey(profile.apiKeySecretName)) : undefined;
    return { ...profile, apiKey };
  }

  getProfiles(): readonly ProviderProfile[] {
    const configured = this.config().get<readonly ProviderProfile[]>("profiles", []);
    const byId = new Map<string, ProviderProfile>();
    for (const profile of defaultProfiles) {
      byId.set(profile.id, profile);
    }
    for (const profile of configured) {
      if (isValidProfile(profile)) {
        byId.set(profile.id, profile);
      }
    }
    return [...byId.values()].filter(isValidProfile);
  }

  async setActiveProfile(profileId: string): Promise<void> {
    await this.config().update("activeProfile", profileId, vscode.ConfigurationTarget.Global);
  }

  async setModel(model: string): Promise<void> {
    await this.updateRepoSetting("model", model);
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    await this.updateRepoSetting("agent.mode", mode);
  }

  async updateSettings(settings: Partial<CodeForgeSettingsUpdate>): Promise<void> {
    const config = this.config();
    const existingAllowlist = normalizeAllowlist(this.getNetworkPolicy().allowlist);
    let allowlist = normalizeAllowlist(settings.allowlist ?? existingAllowlist);
    const baseUrl = settings.baseUrl?.trim();
    const model = settings.model?.trim() || undefined;
    const profileLabel = settings.profileLabel?.trim() || "OpenAI API";
    if (settings.baseUrl !== undefined) {
      if (!baseUrl) {
        throw new Error("OpenAI API Base URL is required.");
      }
      if (!isUrlAllowed(baseUrl, { allowlist }).allowed) {
        const endpointEntry = allowlistEntryForUrl(baseUrl);
        if (endpointEntry) {
          allowlist = normalizeAllowlist([...allowlist, endpointEntry]);
        }
      }
      assertUrlAllowed(baseUrl, { allowlist });
    }

    let activeProfileId = settings.activeProfileId || this.getActiveProfileId();
    if (settings.createProfile) {
      if (!baseUrl) {
        throw new Error("OpenAI API Base URL is required.");
      }
      activeProfileId = await this.createOpenAiProfile({
        label: profileLabel,
        baseUrl,
        defaultModel: model,
        apiKey: settings.apiKey?.trim() || undefined
      });
    } else {
      if (settings.activeProfileId) {
        await config.update("activeProfile", settings.activeProfileId, vscode.ConfigurationTarget.Global);
      }
      await this.updateOpenAiProfile(activeProfileId, {
        label: settings.profileLabel,
        baseUrl,
        defaultModel: model,
        apiKey: settings.apiKey?.trim() || undefined
      });
    }
    if (settings.model !== undefined) {
      await this.updateRepoSetting("model", settings.model.trim());
    }
    if (settings.allowlist !== undefined || !sameStringArray(allowlist, existingAllowlist)) {
      await config.update("network.allowlist", allowlist, vscode.ConfigurationTarget.Global);
    }
    if (settings.maxFiles !== undefined) {
      await config.update("context.maxFiles", clampNumber(settings.maxFiles, 1, 200, 24), vscode.ConfigurationTarget.Global);
    }
    if (settings.maxTokens !== undefined) {
      await config.update("context.maxTokens", clampNumber(settings.maxTokens, 0, 10_000_000, 0), vscode.ConfigurationTarget.Global);
    }
    if (settings.maxBytes !== undefined) {
      await config.update("context.maxBytes", clampNumber(settings.maxBytes, 8000, 2_000_000, 120000), vscode.ConfigurationTarget.Global);
    }
    if (settings.commandTimeoutSeconds !== undefined) {
      await config.update("commands.timeoutSeconds", clampNumber(settings.commandTimeoutSeconds, 5, 1800, 120), vscode.ConfigurationTarget.Global);
    }
    if (settings.commandOutputLimitBytes !== undefined) {
      await config.update("commands.outputLimitBytes", clampNumber(settings.commandOutputLimitBytes, 16000, 2_000_000, 200000), vscode.ConfigurationTarget.Global);
    }
    if (settings.permissionMode !== undefined) {
      await this.updateRepoSetting("permissions.mode", settings.permissionMode);
    }
    if (settings.permissionRules !== undefined) {
      await this.updateRepoSetting("permissions.rules", settings.permissionRules);
    }
    if (settings.mcpServers !== undefined) {
      await this.updateRepoSetting("mcp.servers", normalizeMcpServerConfigs(settings.mcpServers));
    }
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(sectionName, this.primaryRepoFolder());
  }

  private async updateRepoSetting(key: string, value: unknown): Promise<void> {
    const folder = this.primaryRepoFolder();
    const config = vscode.workspace.getConfiguration(sectionName, folder);
    if (!folder) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      return;
    }
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      if (!isConfigurationTargetWriteError(error)) {
        throw error;
      }
      await vscode.workspace.getConfiguration(sectionName).update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  private primaryRepoFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async createOpenAiProfile(profile: {
    readonly label: string;
    readonly baseUrl: string;
    readonly defaultModel?: string;
    readonly apiKey?: string;
  }): Promise<string> {
    const profileId = uniqueProfileId(this.getProfiles(), profile.label);
    const apiKeySecretName = profile.apiKey ? `${profileId}.apiKey` : undefined;
    if (profile.apiKey && apiKeySecretName) {
      await this.secrets.store(secretKey(apiKeySecretName), profile.apiKey);
    }

    const nextProfile: ProviderProfile = {
      id: profileId,
      label: profile.label,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
      apiKeySecretName
    };
    const configured = this.config().get<readonly ProviderProfile[]>("profiles", []);
    await this.config().update("profiles", [...configured, nextProfile], vscode.ConfigurationTarget.Global);
    await this.config().update("activeProfile", profileId, vscode.ConfigurationTarget.Global);
    return profileId;
  }

  private async updateOpenAiProfile(profileId: string, changes: {
    readonly label?: string;
    readonly baseUrl?: string;
    readonly defaultModel?: string;
    readonly apiKey?: string;
  }): Promise<void> {
    const profile = this.getProfiles().find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Unknown OpenAI API profile: ${profileId}`);
    }

    let apiKeySecretName = profile.apiKeySecretName;
    if (changes.apiKey) {
      apiKeySecretName = apiKeySecretName || `${profileId}.apiKey`;
      await this.secrets.store(secretKey(apiKeySecretName), changes.apiKey);
    }

    const nextProfile: ProviderProfile = {
      ...profile,
      label: changes.label?.trim() || profile.label,
      baseUrl: changes.baseUrl?.trim() || profile.baseUrl,
      defaultModel: changes.defaultModel,
      apiKeySecretName
    };
    const configured = this.config().get<readonly ProviderProfile[]>("profiles", []);
    const existingIndex = configured.findIndex((item) => item.id === profileId);
    const nextProfiles = [...configured];
    if (existingIndex >= 0) {
      nextProfiles[existingIndex] = nextProfile;
    } else {
      nextProfiles.push(nextProfile);
    }
    await this.config().update("profiles", nextProfiles, vscode.ConfigurationTarget.Global);
  }
}

export interface CodeForgeSettingsUpdate {
  readonly activeProfileId: string;
  readonly createProfile: boolean;
  readonly profileLabel: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly allowlist: readonly string[];
  readonly maxFiles: number;
  readonly maxTokens: number;
  readonly maxBytes: number;
  readonly commandTimeoutSeconds: number;
  readonly commandOutputLimitBytes: number;
  readonly permissionMode: PermissionMode;
  readonly permissionRules: readonly PermissionRule[];
  readonly mcpServers: readonly McpServerConfig[];
}

const defaultProfiles: readonly ProviderProfile[] = [
  {
    id: "openai-api-local",
    label: "OpenAI API",
    baseUrl: "http://127.0.0.1:1234",
    defaultModel: "google/gemma-4-e4b"
  }
];

function isValidProfile(profile: ProviderProfile): boolean {
  return Boolean(profile.id && profile.label && profile.baseUrl);
}

function normalizeAllowlist(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === "agent" || value === "ask" || value === "plan";
}

function isConfigurationTargetWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unable to write to (Workspace|Folder) Settings|folder resource scope|workspace folder/i.test(message);
}

export function normalizeMcpServerConfigs(value: readonly unknown[] | undefined): readonly McpServerConfig[] {
  return (value ?? []).map(toMcpServerConfig).filter((server): server is McpServerConfig => server !== undefined);
}

function toMcpServerConfig(value: unknown): McpServerConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : id;
  const transport = value.transport;
  if (!id || !label || (transport !== "stdio" && transport !== "http" && transport !== "sse")) {
    return undefined;
  }
  const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : undefined;
  const headers = isRecord(value.headers)
    ? Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    id,
    label,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    transport,
    command: typeof value.command === "string" ? value.command.trim() : undefined,
    args,
    cwd: typeof value.cwd === "string" ? value.cwd.trim() : undefined,
    url: typeof value.url === "string" ? value.url.trim() : undefined,
    headers
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretKey(name: string): string {
  return `codeforge.profile.${name}`;
}

function uniqueProfileId(existingProfiles: readonly ProviderProfile[], label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "openai-api";
  let id = `openai-api-${slug}`;
  let suffix = 2;
  const existingIds = new Set(existingProfiles.map((profile) => profile.id));
  while (existingIds.has(id)) {
    id = `openai-api-${slug}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
