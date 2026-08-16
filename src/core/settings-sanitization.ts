import type { CurrentNoteAiSettings } from "../settings";
import type { ModelRef, ProviderConsentGrant, ProviderId, ProviderModel, ProviderModelCatalog } from "../types";
import { sanitizeConversationHistory } from "./conversation-history";

const MAX_AVAILABLE_MODELS = 100;
const MAX_MODEL_LENGTH = 200;
const MAX_SECRET_ID_LENGTH = 500;
const MAX_CONTEXT_WINDOW = 2_000_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function boundedString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value : fallback;
}
function modelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_MODEL_LENGTH ? normalized : undefined;
}
function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, step: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(maximum, Math.max(minimum, value));
  return Number((Math.round(clamped / step) * step).toFixed(10));
}
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function sanitizeProviderModel(value: unknown): ProviderModel | undefined {
  const saved = asRecord(value);
  const id = modelId(saved.id);
  if (!id) return undefined;
  const result: ProviderModel = { id };
  if (typeof saved.ownedBy === "string" && saved.ownedBy.length <= MAX_MODEL_LENGTH) {
    result.ownedBy = saved.ownedBy;
  }
  if (typeof saved.contextWindowTokens === "number" && Number.isFinite(saved.contextWindowTokens)
    && Number.isInteger(saved.contextWindowTokens) && saved.contextWindowTokens > 0
    && saved.contextWindowTokens <= MAX_CONTEXT_WINDOW) result.contextWindowTokens = saved.contextWindowTokens;
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
  return { models, lastSuccessfulRefreshAt: nonNegativeInteger(saved.lastSuccessfulRefreshAt) ?? 0 };
}
function sanitizeConsent(value: unknown): ProviderConsentGrant | undefined {
  const saved = asRecord(value);
  const revision = saved.disclosureRevision;
  const acceptedAt = saved.acceptedAt;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > 100) return undefined;
  if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt) || !Number.isInteger(acceptedAt) || acceptedAt < 0) return undefined;
  return { disclosureRevision: revision, acceptedAt };
}

export function sanitizeSettings(value: unknown, defaults: CurrentNoteAiSettings): CurrentNoteAiSettings {
  const saved = asRecord(value);
  const defaultModel = typeof defaults.model === "string" ? defaults.model : "deepseek-v4-flash";
  const defaultSecretId = typeof defaults.secretId === "string" ? defaults.secretId : "";
  const defaultKimiSecretId = typeof defaults.kimiSecretId === "string" ? defaults.kimiSecretId : "";
  const defaultCatalogs = asRecord(defaults.providerCatalogs);
  const defaultDeepSeekCatalog = sanitizeCatalog(defaultCatalogs.deepseek) ?? { models: [], lastSuccessfulRefreshAt: 0 };
  const defaultKimiCatalog = sanitizeCatalog(defaultCatalogs.kimi) ?? { models: [], lastSuccessfulRefreshAt: 0 };
  const legacyModel = modelId(saved.model) ?? modelId(defaultModel) ?? "deepseek-v4-flash";
  const legacySecretId = boundedString(saved.secretId, defaultSecretId, MAX_SECRET_ID_LENGTH);
  const kimiSecretId = boundedString(saved.kimiSecretId, defaultKimiSecretId, MAX_SECRET_ID_LENGTH);
  const legacyModels = Array.isArray(saved.availableModels) ? saved.availableModels.flatMap((candidate) => {
    const id = modelId(candidate);
    return id ? [id] : [];
  }) : [];
  const defaultLegacyModels = Array.isArray(defaults.availableModels) ? defaults.availableModels.flatMap((candidate) => {
    const id = modelId(candidate);
    return id ? [id] : [];
  }) : [];
  const savedCatalogs = asRecord(saved.providerCatalogs);
  const savedDeepSeekCatalog = sanitizeCatalog(savedCatalogs.deepseek);
  const deepSeekCatalog = savedDeepSeekCatalog ?? defaultDeepSeekCatalog;
  const kimiCatalog = sanitizeCatalog(savedCatalogs.kimi) ?? defaultKimiCatalog;
  if (!savedDeepSeekCatalog) {
    const ids = [...defaultDeepSeekCatalog.models.map((item) => item.id), ...defaultLegacyModels, ...legacyModels, legacyModel];
    deepSeekCatalog.models = [...new Set(ids)].slice(0, MAX_AVAILABLE_MODELS).map((id) => ({ id }));
  } else if (!deepSeekCatalog.models.some((item) => item.id === legacyModel)) {
    deepSeekCatalog.models = deepSeekCatalog.models.length >= MAX_AVAILABLE_MODELS
      ? [...deepSeekCatalog.models.slice(0, MAX_AVAILABLE_MODELS - 1), { id: legacyModel }]
      : [...deepSeekCatalog.models, { id: legacyModel }];
  }
  const selectedSaved = asRecord(saved.selectedModel);
  const selectedId = modelId(selectedSaved.modelId);
  const selectedProvider = selectedSaved.providerId;
  const selectedModel: ModelRef = selectedId && (selectedProvider === "deepseek" || selectedProvider === "kimi")
    ? { providerId: selectedProvider as ProviderId, modelId: selectedId } : { providerId: "deepseek", modelId: legacyModel };
  const savedConsents = asRecord(saved.providerConsents);
  const providerConsents: Partial<Record<ProviderId, ProviderConsentGrant>> = {};
  for (const provider of ["deepseek", "kimi"] as const) {
    const grant = sanitizeConsent(savedConsents[provider]);
    if (grant) providerConsents[provider] = grant;
  }
  if (!providerConsents.deepseek && saved.consentAcknowledged === true) providerConsents.deepseek = { disclosureRevision: 1, acceptedAt: 0 };
  return {
    schemaVersion: 2,
    selectedModel,
    kimiSecretId,
    providerCatalogs: { deepseek: deepSeekCatalog, kimi: kimiCatalog },
    providerConsents,
    secretId: legacySecretId,
    model: legacyModel,
    availableModels: deepSeekCatalog.models.map((item) => item.id),
    conversationHistory: sanitizeConversationHistory(saved.conversationHistory),
    maxTokens: boundedNumber(saved.maxTokens, defaults.maxTokens, 512, 16_384, 512),
    temperature: boundedNumber(saved.temperature, defaults.temperature, 0, 1.5, 0.1),
    maxOperations: boundedNumber(saved.maxOperations, defaults.maxOperations, 1, 50, 1),
    maxChangeRatio: boundedNumber(saved.maxChangeRatio, defaults.maxChangeRatio, 0.1, 1, 0.05),
    consentAcknowledged: Boolean(providerConsents.deepseek),
  };
}
