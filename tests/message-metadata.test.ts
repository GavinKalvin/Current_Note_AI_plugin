import { describe, expect, it } from "vitest";
import {
  captureGenerationMetadata,
  formatMessageDateTime,
  reasoningLabel,
} from "../src/core/message-metadata";
import type { CompletionOptions, ProviderProfile } from "../src/types";

function options(model: string, reasoningEffort?: CompletionOptions["reasoningEffort"]): CompletionOptions {
  return { model, maxTokens: 100, responseFormat: "text", ...(reasoningEffort ? { reasoningEffort } : {}) };
}

describe("generation message metadata", () => {
  it("captures an immutable snapshot from the request options rather than mutable profile state", () => {
    const requestOptions = options("request-model", "high");
    const profile = {
      providerId: "chatgpt",
      catalog: { models: [{ id: "profile-model" }] },
      chatgptReasoningEffort: "low",
    } as unknown as ProviderProfile;

    const snapshot = captureGenerationMetadata("chatgpt", requestOptions);
    requestOptions.model = "later-model";
    requestOptions.reasoningEffort = "none";
    profile.chatgptReasoningEffort = "max";
    profile.catalog.models[0]!.id = "changed-profile-model";

    expect(snapshot).toEqual({
      origin: "ai",
      providerId: "chatgpt",
      modelId: "request-model",
      reasoning: "high",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    ["chatgpt", undefined, "auto"],
    ["chatgpt", "none", "none"],
    ["chatgpt", "minimal", "minimal"],
    ["chatgpt", "low", "low"],
    ["chatgpt", "medium", "medium"],
    ["chatgpt", "high", "high"],
    ["chatgpt", "xhigh", "xhigh"],
    ["chatgpt", "max", "max"],
    ["deepseek", undefined, "off"],
    ["kimi", "high", "off"],
    ["kimi-code", undefined, "off"],
  ] as const)("records the request reasoning for %s (%s)", (providerId, effort, expected) => {
    expect(captureGenerationMetadata(providerId, options("chosen-model", effort)).reasoning).toBe(expected);
  });

  it.each([
    ["auto", "Auto"], ["none", "None"], ["minimal", "Minimal"], ["low", "Low"],
    ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"],
    ["off", "Off"], [undefined, "Not recorded"],
  ] as const)("labels reasoning %s", (reasoning, expected) => {
    expect(reasoningLabel(reasoning)).toBe(expected);
  });

  it("formats a valid timestamp to local seconds with a matching ISO instant and IANA zone", () => {
    const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5, 678);
    const result = formatMessageDateTime(timestamp);
    expect(result).not.toBeNull();
    const date = new Date(timestamp);
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZone: result!.timeZone,
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    expect(result).toEqual({
      text: `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`,
      dateTime: date.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(result!.timeZone).toBeTruthy();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE, -1])(
    "rejects invalid timestamp %s",
    (timestamp) => expect(formatMessageDateTime(timestamp)).toBeNull(),
  );
});
