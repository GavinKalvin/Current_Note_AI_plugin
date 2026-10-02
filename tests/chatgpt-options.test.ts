import { describe, expect, it } from "vitest";
import { chatGptEffortChoices, chatGptSpeedLabel, includeChatGptSolModel } from "../src/core/chatgpt-options";

describe("ChatGPT manual options", () => {
  it("supplements Sol without changing the original catalog or claiming account access", () => {
    const existing = [{ id: "gpt-6-astra" }];
    const result = includeChatGptSolModel(existing);
    expect(result[0]).toMatchObject({ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", catalogSource: "manual" });
    expect(result[0]?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(existing).toEqual([{ id: "gpt-6-astra" }]);
    expect(includeChatGptSolModel(result)).toEqual(result);
  });
  it("does not insert Sol before account login or duplicate an account-listed Sol", () => {
    expect(includeChatGptSolModel([])).toEqual([]);
    const listed = [{ id: "gpt-6.1-sol", displayName: "Server Sol" }];
    expect(includeChatGptSolModel(listed)).toEqual(listed);
    expect(includeChatGptSolModel(listed)[0]).not.toHaveProperty("catalogSource");
  });
  it("uses account-declared efforts before any fallback", () => {
    expect(chatGptEffortChoices({ id: "gpt-6.1-sol", supportedReasoningEfforts: ["low", "high"] })).toEqual(["low", "high"]);
  });
  it.each(["gpt-6.1-sol", "gpt-6-astra"])("offers published higher efforts without unsupported none for %s", (id) => {
    expect(chatGptEffortChoices({ id })).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it.each(["gpt-6-sol", "gpt-6-luna"])("allows published none for %s", (id) => {
    expect(chatGptEffortChoices({ id })).toContain("none");
  });
  it("uses conservative candidates for an unknown model and readable actual speed labels", () => {
    expect(chatGptEffortChoices({ id: "future-model" })).toEqual(["low", "medium", "high"]);
    expect(chatGptSpeedLabel("default")).toBe("Standard");
    expect(chatGptSpeedLabel("priority")).toBe("Fast");
    expect(chatGptSpeedLabel("private-provider-string")).toBe("Unknown");
  });
});
