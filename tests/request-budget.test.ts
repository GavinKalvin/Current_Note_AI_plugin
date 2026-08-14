import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTextTokens,
  evaluateRequestBudget,
} from "../src/core/request-budget";

describe("request budget", () => {
  it("estimates ASCII and non-ASCII code points", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("你好")).toBe(2);
    expect(estimateTextTokens("a😀")).toBe(2);
  });

  it("serializes complete messages and returns the budget breakdown", () => {
    const messages = [{ role: "user" as const, content: "你好" }];
    const estimatedInputTokens = estimateTextTokens(JSON.stringify(messages)) + 4 + 16;
    const safetyMarginTokens = Math.ceil((estimatedInputTokens + 100) * 0.1);
    const result = evaluateRequestBudget(messages, 100);
    expect(result).toEqual({
      estimatedInputTokens,
      reservedOutputTokens: 100,
      safetyMarginTokens,
      requiredTokens: estimatedInputTokens + 100 + safetyMarginTokens,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      fits: true,
    });
    expect(result.requiredTokens).toBe(
      result.estimatedInputTokens + result.reservedOutputTokens + result.safetyMarginTokens,
    );
  });

  it("handles exact and just-over limits", () => {
    const base = evaluateRequestBudget([], 1, { contextWindowTokens: 100, safetyMarginRatio: 0 });
    expect(base.requiredTokens).toBe(18);
    expect(evaluateRequestBudget([], 83, { contextWindowTokens: 100, safetyMarginRatio: 0 }).fits).toBe(true);
    expect(evaluateRequestBudget([], 84, { contextWindowTokens: 100, safetyMarginRatio: 0 }).fits).toBe(false);
  });

  it("rejects invalid numeric inputs", () => {
    expect(() => evaluateRequestBudget([], 0)).toThrow(RangeError);
    expect(() => evaluateRequestBudget([], Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => evaluateRequestBudget([], 1, { contextWindowTokens: 0 })).toThrow(RangeError);
    expect(() => evaluateRequestBudget([], 1, { safetyMarginRatio: -0.01 })).toThrow(RangeError);
    expect(() => evaluateRequestBudget([], 1, { safetyMarginRatio: 1 })).toThrow(RangeError);
    expect(() => evaluateRequestBudget([], 1, { safetyMarginRatio: Number.NaN })).toThrow(RangeError);
  });
});
