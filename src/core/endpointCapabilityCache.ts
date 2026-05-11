import { ModelInfo, ProviderCapabilities } from "./types";

export interface CachedModelCapability {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly backendLabel?: string;
  readonly modelInfo?: ModelInfo;
  readonly capabilities: ProviderCapabilities;
  readonly checkedAt: number;
}

export interface EndpointCapabilityStore {
  get(profileId: string, baseUrl: string, model: string): Promise<CachedModelCapability | undefined>;
  upsert(entry: CachedModelCapability): Promise<void>;
  list(profileId?: string): Promise<readonly CachedModelCapability[]>;
}

export function isFreshCapability(entry: CachedModelCapability, now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  return now - entry.checkedAt <= maxAgeMs;
}

export function capabilityKey(profileId: string, baseUrl: string, model: string): string {
  return `${profileId}\u0000${baseUrl}\u0000${model}`;
}
