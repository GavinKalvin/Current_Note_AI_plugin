import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/core/settings-sanitization";
import { MAX_PROVIDER_PROFILES } from "../src/core/provider-profiles";
import type { CurrentNoteAiSettings } from "../src/settings";

const DEFAULT_SETTINGS = {
  schemaVersion: 3,
  providerProfiles: [],
  selectedProfileModel: null,
  profileConsents: {},
  migrationVersion: 3,
  selectedModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
  kimiSecretId: "",
  providerCatalogs: {
    deepseek: { models: [{ id: "deepseek-v4-flash" }], lastSuccessfulRefreshAt: 0 },
    kimi: { models: [], lastSuccessfulRefreshAt: 0 },
  },
  providerConsents: {},
  secretId: "",
  model: "deepseek-v4-flash",
  availableModels: ["deepseek-v4-flash"],
  conversationHistory: [],
  maxTokens: 4_096,
  temperature: 0.3,
  maxOperations: 20,
  maxChangeRatio: 0.5,
  consentAcknowledged: false,
} satisfies CurrentNoteAiSettings;

describe("schema-v3 provider profile migration", () => {
  it("creates deterministic legacy profiles and maps legacy consent/selection", () => {
    const result = sanitizeSettings({
      secretId: "deepseek-secret-id",
      kimiSecretId: "kimi-secret-id",
      model: "legacy-deepseek-model",
      availableModels: ["legacy-deepseek-model"],
      providerCatalogs: {
        deepseek: { models: [{ id: "legacy-deepseek-model", contextWindowTokens: 64_000 }], lastSuccessfulRefreshAt: 11 },
        kimi: { models: [{ id: "kimi-k2.6" }], lastSuccessfulRefreshAt: 12 },
      },
      providerConsents: { kimi: { disclosureRevision: 2, acceptedAt: 13 } },
      selectedModel: { providerId: "kimi", modelId: "kimi-k2.6" },
      conversationHistory: [],
    }, DEFAULT_SETTINGS);

    expect(result.schemaVersion).toBe(3);
    expect(result.migrationVersion).toBe(3);
    expect(result.providerProfiles.slice(0, 2)).toMatchObject([
      { id: "legacy-deepseek", providerId: "deepseek", secretId: "deepseek-secret-id" },
      { id: "legacy-kimi", providerId: "kimi", secretId: "kimi-secret-id" },
    ]);
    expect(result.providerProfiles[0]?.catalog.models).toEqual([{ id: "legacy-deepseek-model", contextWindowTokens: 64_000 }]);
    expect(result.providerProfiles[1]?.catalog.models).toEqual([{ id: "kimi-k2.6" }]);
    expect(result.selectedProfileModel).toEqual({ profileId: "legacy-kimi", modelId: "kimi-k2.6" });
    expect(result.profileConsents["legacy-kimi"]).toEqual({
      disclosureRevision: 2,
      acceptedAt: 13,
      profileRevision: 1,
      providerId: "kimi",
    });
    expect(result.secretId).toBe("deepseek-secret-id");
    expect(result.kimiSecretId).toBe("kimi-secret-id");
  });

  it("is bounded, deduplicated, deeply cloned, and idempotent", () => {
    const profiles = Array.from({ length: MAX_PROVIDER_PROFILES + 10 }, (_, index) => ({
      id: `profile-${index}`,
      label: `Profile ${index}`,
      providerId: index % 2 === 0 ? "deepseek" : "kimi",
      secretId: `secret-${index}`,
      enabled: true,
      revision: index + 1,
      catalog: { models: [{ id: `model-${index}` }], lastSuccessfulRefreshAt: index },
    }));
    profiles.push({ ...profiles[0]!, id: "profile-1" });

    const once = sanitizeSettings({ providerProfiles: profiles }, DEFAULT_SETTINGS);
    const twice = sanitizeSettings(once, DEFAULT_SETTINGS);

    expect(once.providerProfiles).toHaveLength(MAX_PROVIDER_PROFILES);
    expect(new Set(once.providerProfiles.map((profile) => profile.id)).size).toBe(MAX_PROVIDER_PROFILES);
    expect(once.providerProfiles.map((profile) => profile.id)).toEqual(twice.providerProfiles.map((profile) => profile.id));
    expect(twice).toEqual(once);
    expect(twice).not.toBe(once);
    expect(twice.providerProfiles).not.toBe(once.providerProfiles);
    expect(twice.providerProfiles[0]?.catalog).not.toBe(once.providerProfiles[0]?.catalog);
  });

  it("drops malformed profiles and never copies raw secret fields", () => {
    const result = sanitizeSettings({
      apiKey: "do-not-store",
      providerProfiles: [
        { id: " ", label: "bad", providerId: "deepseek", secretId: "bad" },
        { id: "__proto__", label: "dangerous", providerId: "deepseek", secretId: "bad" },
        { id: "custom", label: "Custom", providerId: "openai", apiKey: "do-not-store" },
        { id: "valid", label: " Valid ", providerId: "deepseek", revision: -1, catalog: { models: [] } },
      ],
    }, DEFAULT_SETTINGS);

    expect(result.providerProfiles.map((profile) => profile.id)).toEqual([
      "legacy-deepseek",
      "legacy-kimi",
      "valid",
    ]);
    expect(result.providerProfiles.find((profile) => profile.id === "valid")).toMatchObject({
      label: "Valid",
      revision: 1,
      secretId: "",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-store");
  });

  it("does not resurrect a deleted legacy profile after schema v3 is saved", () => {
    const migrated = sanitizeSettings({ secretId: "legacy-secret" }, DEFAULT_SETTINGS);
    migrated.providerProfiles = migrated.providerProfiles.filter((profile) => profile.id !== "legacy-deepseek");
    migrated.selectedProfileModel = null;

    const reloaded = sanitizeSettings(migrated, DEFAULT_SETTINGS);

    expect(reloaded.providerProfiles.some((profile) => profile.id === "legacy-deepseek")).toBe(false);
    expect(reloaded.selectedProfileModel).toBeNull();
  });

  it("keeps two accounts of one supplier isolated even when model IDs match", () => {
    const saved = {
      ...DEFAULT_SETTINGS,
      providerProfiles: [
        {
          id: "deepseek-work",
          label: "Work",
          providerId: "deepseek",
          secretId: "work-secret-ref",
          enabled: true,
          revision: 2,
          catalog: { models: [{ id: "shared-model", ownedBy: "work" }], lastSuccessfulRefreshAt: 11 },
        },
        {
          id: "deepseek-personal",
          label: "Personal",
          providerId: "deepseek",
          secretId: "personal-secret-ref",
          enabled: true,
          revision: 4,
          catalog: { models: [{ id: "shared-model", ownedBy: "personal" }], lastSuccessfulRefreshAt: 12 },
        },
      ],
      selectedProfileModel: { profileId: "deepseek-personal", modelId: "shared-model" },
    };

    const result = sanitizeSettings(saved, DEFAULT_SETTINGS);

    expect(result.providerProfiles).toHaveLength(2);
    expect(result.providerProfiles.map((profile) => [profile.id, profile.secretId, profile.catalog.models[0]?.ownedBy])).toEqual([
      ["deepseek-work", "work-secret-ref", "work"],
      ["deepseek-personal", "personal-secret-ref", "personal"],
    ]);
    expect(result.selectedProfileModel).toEqual({ profileId: "deepseek-personal", modelId: "shared-model" });
  });
});
