import { describe, expect, it } from "vitest";
import {
  nextEditRetryBudget,
  parseCompletionUsage,
  trimExactContinuationOverlap,
} from "../src/core/completion";

describe("parseCompletionUsage", () => {
  it("extracts reasoning and visible output token counts", () => {
    expect(parseCompletionUsage({
      prompt_tokens: 1_000,
      completion_tokens: 4_096,
      total_tokens: 5_096,
      completion_tokens_details: { reasoning_tokens: 1_500 },
    })).toEqual({
      promptTokens: 1_000,
      completionTokens: 4_096,
      reasoningTokens: 1_500,
      visibleOutputTokens: 2_596,
      totalTokens: 5_096,
    });
  });

  it("ignores malformed usage values", () => {
    expect(parseCompletionUsage(null)).toBeUndefined();
    expect(parseCompletionUsage({ completion_tokens: -1 })?.completionTokens).toBeUndefined();
  });
});

describe("nextEditRetryBudget", () => {
  it.each([
    [4_096, 8_192],
    [6_144, 8_192],
    [8_192, 16_384],
    [16_384, null],
  ])("maps %i to %s", (current, expected) => {
    expect(nextEditRetryBudget(current)).toBe(expected);
  });
});

describe("trimExactContinuationOverlap", () => {
  it("removes only a sufficiently long exact overlap", () => {
    const overlap = "This exact sentence was already shown.";
    expect(trimExactContinuationOverlap(
      `Earlier text. ${overlap}`,
      `${overlap} New material follows.`,
    )).toBe("New material follows.");
  });

  it("keeps short or approximate repetition untouched", () => {
    expect(trimExactContinuationOverlap("Ends with a phrase.", "a phrase. More"))
      .toBe("a phrase. More");
  });
});
