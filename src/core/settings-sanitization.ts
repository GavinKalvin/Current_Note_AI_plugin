import type { CurrentNoteAiSettings } from "../settings";
import type {
  ModelRef,
  ProfileConsentGrant,
  ProfileModelRef,
  ProviderConsentGrant,
  ProviderId,
  ProviderModel,
  ProviderModelCatalog,
  ProviderProfile,
} from "../types";
import {
  LEGACY_DEEPSEEK_PROFILE_ID,
  LEGACY_KIMI_PROFILE_ID,
  MAX_PROVIDER_PROFILES,
} from "./provider-profiles";
import { sanitizeConversationHistory } from "./conversation-history";

const PROVIDER_IDS = ["deepseek", "kimi"] as const;
const MAX_AVAILABLE_MODELS = 100;
const MAX_MODEL_LENGTH = 200;
const MAX_PROFILE_ID_LENGTH = 200;
const MAX_PROFILE_LABEL_LENGTH = 200;
const MAX_SECRET_ID_LENGTH = 500;
const MAX_CONTEXT_WINDOW = 2_000_000;
const MAX_PROFILE_REVISION = 1_000_000;
const MAX_DISCLOSURE_REVISION = 100;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value : fallback;
}

function modelId(value: unknown): string | undefined {
  return trimmedString(value, MAX_MODEL_LENGTH);
}

function profileId(value: unknown): string | undefined {
  const id = trimmedString(value, MAX_PROFILE_ID_LENGTH);
  return id === "__proto__" || id === "prototype" || id === "constructor"
    ? undefined
    : id;
}

function label(value: unknown): string | undefined {
  return trimmedString(value, MAX_PROFILE_LABEL_LENGTH);
}

function trimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  step: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(maximum, Math.max(minimum, value));
  return Number((Math.round(clamped / step) * step).toFixed(10));
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMESTAMP
    ? value
    : undefined;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= maximum
    ? value
    : undefined;
}

function providerId(value: unknown): ProviderId | undefined {
  return value === "deepseek" || value === "kimi" ? value : undefined;
}

function sanitizeProviderModel(value: unknown): ProviderModel | undefined {
  const saved = asRecord(value);
  const id = modelId(saved.id);
  if (!id) return undefined;

  const result: ProviderModel = { id };
  if (typeof saved.ownedBy === "string" && saved.ownedBy.length <= MAX_MODEL_LENGTH) {
    result.ownedBy = saved.ownedBy;
  }
  if (typeof saved.contextWindowTokens === "number" && Number.isSafeInteger(saved.contextWindowTokens)
    && saved.contextWindowTokens > 0 && saved.contextWindowTokens <= MAX_CONTEXT_WINDOW) {
    result.contextWindowTokens = saved.contextWindowTokens;
  }
  if (typeof saved.supportsReasoning === "boolean") result.supportsReasoning = saved.supportsReasoning;
  return result;
}

function sanitizeCatalog(value: unknown): ProviderModelCatalog | undefined {
  const saved = asRecord(value);
  if (!Array.isArray(saved.models)) return undefined;

  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const candidate of saved.models) {
    const model = sanitizeProviderModel(candidate);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
    if (models.length >= MAX_AVAILABLE_MODELS) break;
  }
  return {
    models,
    lastSuccessfulRefreshAt: nonNegativeInteger(saved.lastSuccessfulRefreshAt) ?? 0,
  };
}

function emptyCatalog(): ProviderModelCatalog {
  return { models: [], lastSuccessfulRefreshAt: 0 };
}

function cloneCatalog(catalog: ProviderModelCatalog): ProviderModelCatalog {
  return {
    models: catalog.models.map((model) => ({ ...model })),
    lastSuccessfulRefreshAt: catalog.lastSuccessfulRefreshAt,
  };
}

function mergeLegacyModel(catalog: ProviderModelCatalog, legacyModel: string): ProviderModelCatalog {
  const cloned = cloneCatalog(catalog);
  if (cloned.models.some((item) => item.id === legacyModel)) return cloned;
  if (cloned.models.length >= MAX_AVAILABLE_MODELS) {
    cloned.models = [...cloned.models.slice(0, MAX_AVAILABLE_MODELS - 1), { id: legacyModel }];
  } else {
    cloned.models.push({ id: legacyModel });
  }
  return cloned;
}

function catalogWithLegacyModels(
  savedCatalog: unknown,
  defaultCatalog: ProviderModelCatalog,
  defaultAvailableModels: readonly unknown[],
  legacyAvailableModels: readonly unknown[],
  legacyModel: string,
): ProviderModelCatalog {
  const sanitizedSaved = sanitizeCatalog(savedCatalog);
  if (sanitizedSaved) return mergeLegacyModel(sanitizedSaved, legacyModel);

  const ids = [
    ...defaultCatalog.models.map((item) => item.id),
    ...modelIds(defaultAvailableModels),
    ...modelIds(legacyAvailableModels),
    legacyModel,
  ];
  const models = [...new Set(ids)].slice(0, MAX_AVAILABLE_MODELS).map((id) => ({ id }));
  return { models, lastSuccessfulRefreshAt: defaultCatalog.lastSuccessfulRefreshAt };
}

function modelIds(value: readonly unknown[]): string[] {
  return value.flatMap((candidate) => {
    const id = modelId(candidate);
    return id ? [id] : [];
  });
}

function sanitizeConsent(value: unknown): ProviderConsentGrant | undefined {
  const saved = asRecord(value);
  const disclosureRevision = positiveInteger(saved.disclosureRevision, MAX_DISCLOSURE_REVISION);
  const acceptedAt = nonNegativeInteger(saved.acceptedAt);
  if (disclosureRevision === undefined || acceptedAt === undefined) return undefined;
  return { disclosureRevision, acceptedAt };
}

function sanitizeProfileConsent(
  value: unknown,
  profile: ProviderProfile,
): ProfileConsentGrant | undefined {
  const saved = asRecord(value);
  const base = sanitizeConsent(saved);
  const profileRevision = positiveInteger(saved.profileRevision, MAX_PROFILE_REVISION);
  const consentProvider = providerId(saved.providerId);
  if (!base || profileRevision !== profile.revision || consentProvider !== profile.providerId) return undefined;
  return { ...base, profileRevision, providerId: consentProvider };
}

function sanitizeProfile(
  value: unknown,
  fallbackCatalogs: Record<ProviderId, ProviderModelCatalog>,
): ProviderProfile | undefined {
  const saved = asRecord(value);
  const id = profileId(saved.id);
  const profileLabel = label(saved.label);
  const provider = providerId(saved.providerId);
  if (!id || !profileLabel || !provider) return undefined;

  return {
    id,
    label: profileLabel,
    providerId: provider,
    // This is a vault-secret reference, never an API-key value. Unknown secret
    // fields are intentionally ignored by this sanitizer.
    secretId: boundedString(saved.secretId, "", MAX_SECRET_ID_LENGTH),
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
    revision: positiveInteger(saved.revision, MAX_PROFILE_REVISION) ?? 1,
    catalog: cloneCatalog(sanitizeCatalog(saved.catalog) ?? fallbackCatalogs[provider]),
  };
}

function legacyProfile(
  id: string,
  profileLabel: string,
  provider: ProviderId,
  secretId: string,
  catalog: ProviderModelCatalog,
): ProviderProfile {
  return {
    id,
    label: profileLabel,
    providerId: provider,
    secretId,
    enabled: true,
    revision: 1,
    catalog: cloneCatalog(catalog),
  };
}

function sanitizeProfileModel(value: unknown, profiles: readonly ProviderProfile[]): ProfileModelRef | null | undefined {
  if (value === null) return null;
  const saved = asRecord(value);
  const id = profileId(saved.profileId);
  const model = modelId(saved.modelId);
  if (!id || !model || !profiles.some((profile) => profile.id === id)) return undefined;
  return { profileId: id, modelId: model };
}

function legacyProfileIdFor(provider: ProviderId): string {
  return provider === "deepseek" ? LEGACY_DEEPSEEK_PROFILE_ID : LEGACY_KIMI_PROFILE_ID;
}

function migrateProfiles(
  saved: Record<string, unknown>,
  deepSeekCatalog: ProviderModelCatalog,
  kimiCatalog: ProviderModelCatalog,
  deepSeekSecretId: string,
  kimiSecretId: string,
): ProviderProfile[] {
  const fallbackCatalogs: Record<ProviderId, ProviderModelCatalog> = {
    deepseek: deepSeekCatalog,
    kimi: kimiCatalog,
  };
  const parsed: ProviderProfile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved.providerProfiles)) {
    for (const candidate of saved.providerProfiles) {
      const profile = sanitizeProfile(candidate, fallbackCatalogs);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      parsed.push(profile);
    }
  }

  // Once schema v3 has been persisted, the profile array is authoritative.
  // In particular, deleting a migrated legacy profile must not resurrect it on
  // the next load. Legacy profiles are synthesized only during an actual
  // legacy-to-v3 migration.
  if (saved.schemaVersion === 3 && saved.migrationVersion === 3) {
    return parsed.slice(0, MAX_PROVIDER_PROFILES).map((profile) => ({
      ...profile,
      catalog: cloneCatalog(profile.catalog),
    }));
  }

  const legacy = [
    legacyProfile(LEGACY_DEEPSEEK_PROFILE_ID, "DeepSeek", "deepseek", deepSeekSecretId, deepSeekCatalog),
    legacyProfile(LEGACY_KIMI_PROFILE_ID, "Kimi", "kimi", kimiSecretId, kimiCatalog),
  ];
  const ordered = [
    ...legacy.map((candidate) => parsed.find((profile) => profile.id === candidate.id
      && profile.providerId === candidate.providerId) ?? candidate),
    ...parsed.filter((profile) => profile.id !== LEGACY_DEEPSEEK_PROFILE_ID && profile.id !== LEGACY_KIMI_PROFILE_ID),
  ];
  return ordered.slice(0, MAX_PROVIDER_PROFILES).map((profile) => ({
    ...profile,
    catalog: cloneCatalog(profile.catalog),
  }));
}

function sanitizeSelectedModel(value: unknown, fallback: ModelRef): ModelRef {
  const saved = asRecord(value);
  const provider = providerId(saved.providerId);
  const model = modelId(saved.modelId);
  return provider && model ? { providerId: provider, modelId: model } : { ...fallback };
}

function sanitizeLegacyModel(value: unknown, fallback: unknown): string {
  return modelId(value) ?? modelId(fallback) ?? "deepseek-v4-flash";
}

export function sanitizeSettings(value: unknown, defaults: CurrentNoteAiSettings): CurrentNoteAiSettings {
  const saved = asRecord(value);
  const defaultSettings = asRecord(defaults);
  const defaultModel = sanitizeLegacyModel(defaultSettings.model, "deepseek-v4-flash");
  const defaultSecretId = typeof defaultSettings.secretId === "string" ? defaultSettings.secretId : "";
  const defaultKimiSecretId = typeof defaultSettings.kimiSecretId === "string" ? defaultSettings.kimiSecretId : "";
  const defaultCatalogs = asRecord(defaultSettings.providerCatalogs);
  const defaultDeepSeekCatalog = sanitizeCatalog(defaultCatalogs.deepseek) ?? emptyCatalog();
  const defaultKimiCatalog = sanitizeCatalog(defaultCatalogs.kimi) ?? emptyCatalog();
  const legacyModel = sanitizeLegacyModel(saved.model, defaultModel);
  const legacySecretId = boundedString(saved.secretId, defaultSecretId, MAX_SECRET_ID_LENGTH);
  const kimiSecretId = boundedString(saved.kimiSecretId, defaultKimiSecretId, MAX_SECRET_ID_LENGTH);
  const defaultAvailableModels = Array.isArray(defaultSettings.availableModels) ? defaultSettings.availableModels : [];
  const legacyAvailableModels = Array.isArray(saved.availableModels) ? saved.availableModels : [];
  const savedCatalogs = asRecord(saved.providerCatalogs);
  const deepSeekCatalog = catalogWithLegacyModels(
    savedCatalogs.deepseek,
    defaultDeepSeekCatalog,
    defaultAvailableModels,
    legacyAvailableModels,
    legacyModel,
  );
  const kimiCatalog = sanitizeCatalog(savedCatalogs.kimi) ?? cloneCatalog(defaultKimiCatalog);
  const selectedModel = sanitizeSelectedModel(
    saved.selectedModel,
    { providerId: "deepseek", modelId: legacyModel },
  );
  const providerConsents: Partial<Record<ProviderId, ProviderConsentGrant>> = {};
  const savedConsents = asRecord(saved.providerConsents);
  for (const provider of PROVIDER_IDS) {
    const grant = sanitizeConsent(savedConsents[provider]);
    if (grant) providerConsents[provider] = { ...grant };
  }
  if (!providerConsents.deepseek && saved.consentAcknowledged === true) {
    providerConsents.deepseek = { disclosureRevision: 1, acceptedAt: 0 };
  }

  const providerProfiles = migrateProfiles(
    saved,
    deepSeekCatalog,
    kimiCatalog,
    legacySecretId,
    kimiSecretId,
  );
  const profileById = new Map(providerProfiles.map((profile) => [profile.id, profile]));
  const savedProfileConsents = asRecord(saved.profileConsents);
  const profileConsents: Record<string, ProfileConsentGrant> = {};
  for (const profile of providerProfiles) {
    const existing = sanitizeProfileConsent(savedProfileConsents[profile.id], profile);
    if (existing) {
      profileConsents[profile.id] = existing;
      continue;
    }
    const legacyConsent = providerConsents[profile.providerId];
    if (profile.id === legacyProfileIdFor(profile.providerId) && legacyConsent) {
      profileConsents[profile.id] = {
        ...legacyConsent,
        profileRevision: profile.revision,
        providerId: profile.providerId,
      };
    }
  }

  const selectedProfileValue = sanitizeProfileModel(saved.selectedProfileModel, providerProfiles);
  let selectedProfileModel: ProfileModelRef | null;
  if (selectedProfileValue !== undefined) {
    selectedProfileModel = selectedProfileValue;
  } else {
    const legacy = profileById.get(legacyProfileIdFor(selectedModel.providerId));
    selectedProfileModel = legacy
      ? { profileId: legacy.id, modelId: selectedModel.modelId }
      : null;
  }

  return {
    schemaVersion: 3,
    providerProfiles,
    selectedProfileModel,
    profileConsents,
    migrationVersion: 3,
    // Keep all v0.1.6 shadow fields present and sanitized for rollback and
    // older installed binaries. No secret material is copied from unknown keys.
    selectedModel,
    kimiSecretId,
    providerCatalogs: {
      deepseek: cloneCatalog(deepSeekCatalog),
      kimi: cloneCatalog(kimiCatalog),
    },
    providerConsents,
    secretId: legacySecretId,
    model: legacyModel,
    availableModels: deepSeekCatalog.models.map((item) => item.id),
    conversationHistory: sanitizeConversationHistory(saved.conversationHistory),
    maxTokens: boundedNumber(saved.maxTokens, numericDefault(defaultSettings.maxTokens, 4_096), 512, 16_384, 512),
    temperature: boundedNumber(saved.temperature, numericDefault(defaultSettings.temperature, 0.3), 0, 1.5, 0.1),
    maxOperations: boundedNumber(saved.maxOperations, numericDefault(defaultSettings.maxOperations, 20), 1, 50, 1),
    maxChangeRatio: boundedNumber(saved.maxChangeRatio, numericDefault(defaultSettings.maxChangeRatio, 0.5), 0.1, 1, 0.05),
    consentAcknowledged: Boolean(providerConsents.deepseek),
  };
}

function numericDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
