import type { CurrentNoteAiSettings } from "../settings";
import { sanitizeConversationHistory } from "./conversation-history";

const MAX_AVAILABLE_MODELS = 100;
const MAX_MODEL_LENGTH = 200;
const MAX_SECRET_ID_LENGTH = 500;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  step: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(maximum, Math.max(minimum, value));
  const stepped = Math.round(clamped / step) * step;
  return Number(stepped.toFixed(10));
}

export function sanitizeSettings(
  value: unknown,
  defaults: CurrentNoteAiSettings,
): CurrentNoteAiSettings {
  const saved = asRecord(value);
  const modelCandidate = boundedString(saved.model, defaults.model, MAX_MODEL_LENGTH).trim();
  const model = modelCandidate || defaults.model;
  const savedModels = Array.isArray(saved.availableModels)
    ? saved.availableModels.flatMap((candidate) => {
      if (typeof candidate !== "string") return [];
      const normalized = candidate.trim();
      return normalized.length > 0 && normalized.length <= MAX_MODEL_LENGTH ? [normalized] : [];
    })
    : [];
  const availableModels = [...new Set([
    ...defaults.availableModels,
    model,
    ...savedModels,
  ])].slice(0, MAX_AVAILABLE_MODELS);

  return {
    secretId: boundedString(saved.secretId, defaults.secretId, MAX_SECRET_ID_LENGTH),
    model,
    availableModels,
    conversationHistory: sanitizeConversationHistory(saved.conversationHistory),
    maxTokens: boundedNumber(saved.maxTokens, defaults.maxTokens, 512, 16_384, 512),
    temperature: boundedNumber(saved.temperature, defaults.temperature, 0, 1.5, 0.1),
    maxOperations: boundedNumber(saved.maxOperations, defaults.maxOperations, 1, 50, 1),
    maxChangeRatio: boundedNumber(saved.maxChangeRatio, defaults.maxChangeRatio, 0.1, 1, 0.05),
    consentAcknowledged: saved.consentAcknowledged === true,
  };
}
