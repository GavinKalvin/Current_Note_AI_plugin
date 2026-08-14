import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/core/settings-sanitization";
import type { CurrentNoteAiSettings } from "../src/settings";

const defaults: CurrentNoteAiSettings = {
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
  it("returns independent defaults for non-object input", () => {
    const result = sanitizeSettings(null, defaults);
    expect(result).toEqual(defaults);
    expect(result).not.toBe(defaults);
    expect(result.availableModels).not.toBe(defaults.availableModels);
  });

  it("normalizes models and clamps numeric settings", () => {
    const result = sanitizeSettings({
      model: "  custom-model  ",
      availableModels: ["custom-model", "  another-model ", "", 42],
      maxTokens: 99_999,
      temperature: -2,
      maxOperations: 4.6,
      maxChangeRatio: 0.333,
    }, defaults);

    expect(result.model).toBe("custom-model");
    expect(result.availableModels).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "custom-model",
      "another-model",
    ]);
    expect(result.maxTokens).toBe(16_384);
    expect(result.temperature).toBe(0);
    expect(result.maxOperations).toBe(5);
    expect(result.maxChangeRatio).toBe(0.35);
  });

  it("rejects malformed types and requires literal true for consent", () => {
    const result = sanitizeSettings({
      secretId: 123,
      model: "",
      maxTokens: "16384",
      temperature: Number.NaN,
      maxOperations: null,
      maxChangeRatio: {},
      consentAcknowledged: "true",
    }, defaults);

    expect(result.secretId).toBe("");
    expect(result.model).toBe(defaults.model);
    expect(result.maxTokens).toBe(defaults.maxTokens);
    expect(result.temperature).toBe(defaults.temperature);
    expect(result.maxOperations).toBe(defaults.maxOperations);
    expect(result.maxChangeRatio).toBe(defaults.maxChangeRatio);
    expect(result.consentAcknowledged).toBe(false);
  });

  it("keeps consent only when the stored value is exactly true", () => {
    expect(sanitizeSettings({ consentAcknowledged: true }, defaults).consentAcknowledged)
      .toBe(true);
  });
});
