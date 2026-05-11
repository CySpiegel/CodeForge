import * as vscode from "vscode";
import { CachedModelCapability, capabilityKey, EndpointCapabilityStore } from "../core/endpointCapabilityCache";

const capabilityKeyName = "codeforge.endpointCapabilities";

export class VsCodeEndpointCapabilityStore implements EndpointCapabilityStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async get(profileId: string, baseUrl: string, model: string): Promise<CachedModelCapability | undefined> {
    return (await this.list()).find((entry) => capabilityKey(entry.profileId, entry.baseUrl, entry.model) === capabilityKey(profileId, baseUrl, model));
  }

  async upsert(entry: CachedModelCapability): Promise<void> {
    this.writeQueue = this.writeQueue.then(
      () => this.upsertNow(entry),
      () => this.upsertNow(entry)
    );
    return this.writeQueue;
  }

  async list(profileId?: string): Promise<readonly CachedModelCapability[]> {
    await this.flushPendingWrites();
    const raw = this.context.globalState.get<readonly unknown[]>(capabilityKeyName, []);
    return raw.map(toCachedModelCapability)
      .filter((entry): entry is CachedModelCapability => Boolean(entry))
      .filter((entry) => !profileId || entry.profileId === profileId)
      .sort((left, right) => right.checkedAt - left.checkedAt);
  }

  private async upsertNow(entry: CachedModelCapability): Promise<void> {
    const entries = await this.list();
    const key = capabilityKey(entry.profileId, entry.baseUrl, entry.model);
    const next = [
      entry,
      ...entries.filter((item) => capabilityKey(item.profileId, item.baseUrl, item.model) !== key)
    ].slice(0, 200);
    await this.context.globalState.update(capabilityKeyName, next);
  }

  private async flushPendingWrites(): Promise<void> {
    try {
      await this.writeQueue;
    } catch {
      // The next write retries through the queue rejection path.
    }
  }
}

function toCachedModelCapability(value: unknown): CachedModelCapability | undefined {
  if (!isObject(value) || typeof value.profileId !== "string" || typeof value.baseUrl !== "string" || typeof value.model !== "string" || typeof value.checkedAt !== "number" || !isObject(value.capabilities)) {
    return undefined;
  }
  const capabilities = value.capabilities;
  if (typeof capabilities.streaming !== "boolean" || typeof capabilities.modelListing !== "boolean" || typeof capabilities.nativeToolCalls !== "boolean") {
    return undefined;
  }
  return {
    profileId: value.profileId,
    baseUrl: value.baseUrl,
    model: value.model,
    backendLabel: typeof value.backendLabel === "string" ? value.backendLabel : undefined,
    modelInfo: isObject(value.modelInfo) && typeof value.modelInfo.id === "string"
      ? {
        id: value.modelInfo.id,
        type: typeof value.modelInfo.type === "string" ? value.modelInfo.type : undefined,
        contextLength: typeof value.modelInfo.contextLength === "number" ? value.modelInfo.contextLength : undefined,
        maxOutputTokens: typeof value.modelInfo.maxOutputTokens === "number" ? value.modelInfo.maxOutputTokens : undefined,
        supportsReasoning: typeof value.modelInfo.supportsReasoning === "boolean" ? value.modelInfo.supportsReasoning : undefined
      }
      : undefined,
    capabilities: {
      streaming: capabilities.streaming,
      modelListing: capabilities.modelListing,
      nativeToolCalls: capabilities.nativeToolCalls
    },
    checkedAt: value.checkedAt
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
