import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/core/settings-sanitization";
import type { CurrentNoteAiSettings } from "../src/settings";

const defaults: CurrentNoteAiSettings = {
  schemaVersion: 2,
  selectedModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
  kimiSecretId: "",
  providerCatalogs: {
    deepseek: { models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }], lastSuccessfulRefreshAt: 0 },
    kimi: { models: [], lastSuccessfulRefreshAt: 0 },
  },
  providerConsents: {},
  secretId: "",
  model: "deepseek-v4-flash",
  availableModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  conversationHistory: [],
  maxTokens: 4_096,
  temperature: 0.3,
  maxOperations: 20,
  maxChangeRatio: 0.5,
  consentAcknowledged: false,
};

describe("sanitizeSettings", () => {
  it("migrates the v0.1.5 DeepSeek settings deterministically", () => {
    const legacy = {
      secretId: "deepseek-secret",
      model: "  legacy-model  ",
      availableModels: ["legacy-model", " legacy-alt ", "", 42],
      conversationHistory: [],
      maxTokens: 99_999,
      temperature: -2,
      maxOperations: 4.6,
      maxChangeRatio: 0.333,
      consentAcknowledged: true,
    };
    const result = sanitizeSettings(legacy, defaults);

    expect(result.schemaVersion).toBe(2);
    expect(result.selectedModel).toEqual({ providerId: "deepseek", modelId: "legacy-model" });
    expect(result.secretId).toBe("deepseek-secret");
    expect(result.model).toBe("legacy-model");
    expect(result.availableModels).toContain("legacy-model");
    expect(result.providerCatalogs.deepseek.models.map((model) => model.id)).toEqual(result.availableModels);
    expect(result.providerConsents).toEqual({ deepseek: { disclosureRevision: 1, acceptedAt: 0 } });
    expect(result.consentAcknowledged).toBe(true);
    expect(result.maxTokens).toBe(16_384);
    expect(result.temperature).toBe(0);
    expect(result.maxOperations).toBe(5);
    expect(result.maxChangeRatio).toBe(0.35);
  });

  it("is idempotent and returns independent data", () => {
    const once = sanitizeSettings({ model: "custom-model", availableModels: ["custom-model"] }, defaults);
    const twice = sanitizeSettings(once, defaults);
    expect(twice).toEqual(once);
    expect(twice).not.toBe(once);
    expect(twice.availableModels).not.toBe(once.availableModels);
    expect(twice.providerCatalogs.deepseek.models).not.toBe(once.providerCatalogs.deepseek.models);
  });

  it("keeps DeepSeek legacy shadow when Kimi is selected", () => {
    const result = sanitizeSettings({
      secretId: "deepseek-secret",
      model: "deepseek-legacy",
      availableModels: ["deepseek-legacy"],
      kimiSecretId: "kimi-secret",
      selectedModel: { providerId: "kimi", modelId: "moonshot-v1" },
      providerCatalogs: { kimi: { models: [{ id: "moonshot-v1" }], lastSuccessfulRefreshAt: 4 } },
    }, defaults);

    expect(result.selectedModel).toEqual({ providerId: "kimi", modelId: "moonshot-v1" });
    expect(result.secretId).toBe("deepseek-secret");
    expect(result.model).toBe("deepseek-legacy");
    expect(result.availableModels).toContain("deepseek-legacy");
    expect(result.consentAcknowledged).toBe(false);
    expect(result.providerConsents).toEqual({});
  });

  it("fails closed for malformed provider, catalog, and consent values", () => {
    const result = sanitizeSettings({
      schemaVersion: "2",
      secretId: 123,
      kimiSecretId: {},
      model: "",
      selectedModel: { providerId: "other", modelId: "" },
      providerCatalogs: {
        deepseek: { models: [{ id: " valid ", contextWindowTokens: -1, supportsReasoning: "yes" }, null, { id: "" }], lastSuccessfulRefreshAt: -1 },
        kimi: { models: "bad", lastSuccessfulRefreshAt: Number.NaN },
      },
      providerConsents: {
        deepseek: { disclosureRevision: 0, acceptedAt: -1 },
        kimi: { disclosureRevision: 101, acceptedAt: Number.POSITIVE_INFINITY },
      },
      consentAcknowledged: "true",
    }, defaults);

    expect(result.schemaVersion).toBe(2);
    expect(result.selectedModel).toEqual({ providerId: "deepseek", modelId: defaults.model });
    expect(result.secretId).toBe("");
    expect(result.kimiSecretId).toBe("");
    expect(result.providerCatalogs.deepseek.models).toEqual([{ id: "valid" }, { id: defaults.model }]);
    expect(result.providerCatalogs.deepseek.lastSuccessfulRefreshAt).toBe(0);
    expect(result.providerConsents).toEqual({});
    expect(result.consentAcknowledged).toBe(false);
  });

  it("does not implicitly grant Kimi consent", () => {
    const result = sanitizeSettings({ consentAcknowledged: true, selectedModel: { providerId: "kimi", modelId: "moonshot" } }, defaults);
    expect(result.providerConsents).toEqual({ deepseek: { disclosureRevision: 1, acceptedAt: 0 } });
    expect(result.providerConsents.kimi).toBeUndefined();
  });

  it("deduplicates and caps models and validates catalog metadata", () => {
    const models = Array.from({ length: 120 }, (_, index) => ({
      id: `model-${index % 110}`,
      ownedBy: `owner-${index}`,
      contextWindowTokens: index === 1 ? 2_000_001 : 8_192,
      supportsReasoning: index % 2 === 0,
    }));
    const result = sanitizeSettings({
      model: "legacy-model",
      providerCatalogs: {
        deepseek: { models, lastSuccessfulRefreshAt: 12.5 },
        kimi: { models, lastSuccessfulRefreshAt: 99 },
      },
    }, defaults);

    expect(result.providerCatalogs.deepseek.models).toHaveLength(100);
    expect(result.providerCatalogs.kimi.models).toHaveLength(100);
    expect(new Set(result.providerCatalogs.deepseek.models.map((model) => model.id)).size).toBe(100);
    expect(result.providerCatalogs.deepseek.models.some((model) => model.id === "legacy-model")).toBe(true);
    expect(result.providerCatalogs.deepseek.lastSuccessfulRefreshAt).toBe(0);
    expect(result.providerCatalogs.deepseek.models.find((model) => model.id === "model-1")).toEqual({ id: "model-1", ownedBy: "owner-1", supportsReasoning: false });
  });
});
