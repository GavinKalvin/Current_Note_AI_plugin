import type {
  FrozenRequestTarget,
  ProfileModelRef,
  ProviderId,
  ProviderProfile,
} from "../types";

export const LEGACY_DEEPSEEK_PROFILE_ID = "legacy-deepseek";
export const LEGACY_KIMI_PROFILE_ID = "legacy-kimi";
export const MAX_PROVIDER_PROFILES = 32;

export interface ProviderPreset {
  providerId: ProviderId;
  displayName: string;
  baseUrl: string;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    providerId: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
  },
  kimi: {
    providerId: "kimi",
    displayName: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
  },
};

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
