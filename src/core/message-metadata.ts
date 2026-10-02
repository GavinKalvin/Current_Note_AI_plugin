import type { CompletionOptions, MessageReasoning, ProviderId } from "../types";

export interface GenerationMetadata {
  origin: "ai";
  providerId: ProviderId;
  modelId: string;
  reasoning: MessageReasoning;
}

/** Capture before awaiting inference, not from mutable settings after it finishes. */
export function captureGenerationMetadata(providerId: ProviderId, options: CompletionOptions): Readonly<GenerationMetadata> {
  return Object.freeze({
    origin: "ai",
    providerId,
    modelId: options.model,
    // All three other adapters explicitly disable thinking for their requests.
    reasoning: providerId === "chatgpt" ? options.reasoningEffort ?? "auto" : "off",
  });
}

const REASONING_LABELS: Record<MessageReasoning, string> = {
  auto: "Auto", none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "XHigh", max: "Max", off: "Off",
};

export function reasoningLabel(reasoning?: MessageReasoning): string {
  return reasoning === undefined ? "Not recorded" : REASONING_LABELS[reasoning] ?? "Not recorded";
}

/** Stable local wall-clock text plus an absolute instant and explicit zone. */
export function formatMessageDateTime(timestamp: number): { text: string; dateTime: string; timeZone: string } | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    text: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    dateTime: date.toISOString(),
    timeZone: formatter.resolvedOptions().timeZone,
  };
}
