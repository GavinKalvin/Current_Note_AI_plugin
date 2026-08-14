import type { CompletionUsage } from "../types";

export const MAX_DISCUSSION_CONTINUATIONS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function parseCompletionUsage(value: unknown): CompletionUsage | undefined {
  if (!isRecord(value)) return undefined;

  const completionTokens = optionalNumber(value.completion_tokens);
  const details = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : undefined;
  const reasoningTokens = optionalNumber(details?.reasoning_tokens);
  const visibleOutputTokens = completionTokens !== undefined
    ? Math.max(0, completionTokens - (reasoningTokens ?? 0))
    : undefined;

  return {
    promptTokens: optionalNumber(value.prompt_tokens),
    completionTokens,
    reasoningTokens,
    visibleOutputTokens,
    totalTokens: optionalNumber(value.total_tokens),
  };
}

export function nextEditRetryBudget(currentBudget: number): number | null {
  for (const candidate of [8_192, 16_384]) {
    if (currentBudget < candidate) return candidate;
  }
  return null;
}

export function trimExactContinuationOverlap(
  previous: string,
  continuation: string,
  minimumOverlap = 24,
): string {
  const maximumOverlap = Math.min(previous.length, continuation.length, 2_000);
  for (let length = maximumOverlap; length >= minimumOverlap; length -= 1) {
    if (previous.endsWith(continuation.slice(0, length))) {
      return continuation.slice(length).replace(/^\s+/u, "");
    }
  }
  return continuation;
}
