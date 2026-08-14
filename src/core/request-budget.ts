import type { ProviderMessage } from "../types";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000;
const DEFAULT_SAFETY_MARGIN_RATIO = 0.1;
const MESSAGE_OVERHEAD_TOKENS = 4;
const PROTOCOL_OVERHEAD_TOKENS = 16;

export interface RequestBudgetOptions {
  contextWindowTokens?: number;
  safetyMarginRatio?: number;
}

export interface RequestBudgetResult {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  requiredTokens: number;
  contextWindowTokens: number;
  fits: boolean;
}

/** Estimate tokens without requiring a provider-specific tokenizer. */
export function estimateTextTokens(text: string): number {
  let estimate = 0;
  for (const character of text) {
    estimate += character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  }
  return Math.ceil(estimate);
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

export function evaluateRequestBudget(
  messages: readonly ProviderMessage[],
  maxOutputTokens: number,
  options: RequestBudgetOptions = {},
): RequestBudgetResult {
  requireFinitePositive(maxOutputTokens, "maxOutputTokens");

  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  requireFinitePositive(contextWindowTokens, "contextWindowTokens");

  const safetyMarginRatio = options.safetyMarginRatio ?? DEFAULT_SAFETY_MARGIN_RATIO;
  if (!Number.isFinite(safetyMarginRatio) || safetyMarginRatio < 0 || safetyMarginRatio >= 1) {
    throw new RangeError("safetyMarginRatio must be finite, at least 0, and less than 1");
  }

  const serializedMessages = JSON.stringify(messages);
  const estimatedInputTokens =
    estimateTextTokens(serializedMessages) +
    messages.length * MESSAGE_OVERHEAD_TOKENS +
    PROTOCOL_OVERHEAD_TOKENS;
  const reservedOutputTokens = maxOutputTokens;
  const safetyMarginTokens = Math.ceil(
    (estimatedInputTokens + reservedOutputTokens) * safetyMarginRatio,
  );
  const requiredTokens = estimatedInputTokens + reservedOutputTokens + safetyMarginTokens;

  return {
    estimatedInputTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    requiredTokens,
    contextWindowTokens,
    fits: requiredTokens <= contextWindowTokens,
  };
}
