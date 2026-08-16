import type {
  FrozenRequestTarget,
  ProfileModelRef,
  ProviderId,
  ProviderEndpointId,
  ProviderProfile,
} from "../types";

export const LEGACY_DEEPSEEK_PROFILE_ID = "legacy-deepseek";
export const LEGACY_KIMI_PROFILE_ID = "legacy-kimi";
export const MAX_PROVIDER_PROFILES = 32;

export interface ProviderPreset {
  providerId: ProviderId;
  displayName: string;
  defaultEndpointId: ProviderEndpointId;
  endpointIds: readonly ProviderEndpointId[];
}

export interface ProviderEndpointPreset {
  id: ProviderEndpointId;
  providerId: ProviderId;
  displayName: string;
  baseUrl: string;
}

export const PROVIDER_ENDPOINTS: Record<ProviderEndpointId, ProviderEndpointPreset> = {
  "deepseek-official": {
    id: "deepseek-official",
    providerId: "deepseek",
    displayName: "Official",
    baseUrl: "https://api.deepseek.com",
  },
  "kimi-cn": {
    id: "kimi-cn",
    providerId: "kimi",
    displayName: "China",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  "kimi-global": {
    id: "kimi-global",
    providerId: "kimi",
    displayName: "International",
    baseUrl: "https://api.moonshot.ai/v1",
  },
};

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    providerId: "deepseek",
    displayName: "DeepSeek",
    defaultEndpointId: "deepseek-official",
    endpointIds: ["deepseek-official"],
  },
  kimi: {
    providerId: "kimi",
    displayName: "Kimi",
    // Existing Kimi profiles predate region selection. The China endpoint is
    // the safe migration default for this Chinese-language plugin install;
    // international accounts remain explicitly selectable in Settings.
    defaultEndpointId: "kimi-cn",
    endpointIds: ["kimi-cn", "kimi-global"],
  },
};

export function getProviderEndpoint(
  providerId: ProviderId,
  endpointId: ProviderEndpointId,
): ProviderEndpointPreset {
  const endpoint = PROVIDER_ENDPOINTS[endpointId];
  if (!endpoint || endpoint.providerId !== providerId) {
    throw new Error(`Endpoint ${endpointId} does not belong to ${providerId}.`);
  }
  return endpoint;
}

export function defaultEndpointId(providerId: ProviderId): ProviderEndpointId {
  return PROVIDER_PRESETS[providerId].defaultEndpointId;
}

export function findProfile(
  profiles: readonly ProviderProfile[],
  profileId: string,
): ProviderProfile | undefined {
  return profiles.find((profile) => profile.id === profileId);
}

export function sameProfileModel(
  left: ProfileModelRef | null,
  right: ProfileModelRef | null,
): boolean {
  return left?.profileId === right?.profileId && left?.modelId === right?.modelId;
}

export function freezeTarget(
  profile: ProviderProfile,
  modelId: string,
): FrozenRequestTarget {
  return {
    profileId: profile.id,
    profileRevision: profile.revision,
    providerId: profile.providerId,
    modelId,
  };
}

export function createProfileId(existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("Could not allocate a unique provider profile ID.");
}

export function nextProfileLabel(
  profiles: readonly ProviderProfile[],
  providerId: ProviderId,
): string {
  const base = PROVIDER_PRESETS[providerId].displayName;
  const labels = new Set(profiles.map((profile) => profile.label));
  if (!labels.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_PROVIDER_PROFILES + 1; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate)) return candidate;
  }
  return `${base} account`;
}
