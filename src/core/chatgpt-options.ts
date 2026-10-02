import type { ChatGptReasoningEffort, ProviderModel } from "../types";

export const CHATGPT_SOL_MODEL_ID = "gpt-6.1-sol";

/** Preserve account models; never misrepresent an omitted model as account-listed. */
export function includeChatGptSolModel(models: readonly ProviderModel[]): ProviderModel[] {
  if (!models.length || models.some((model) => model.id === CHATGPT_SOL_MODEL_ID)) return [...models];
  return [{
    id: CHATGPT_SOL_MODEL_ID, displayName: "GPT-6.1 Sol", catalogSource: "manual",
    ownedBy: "OpenAI · manually added; account access unverified", contextWindowTokens: 32_000,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  }, ...models];
}

export function chatGptEffortChoices(model: ProviderModel | undefined): Exclude<ChatGptReasoningEffort, "auto">[] {
  if (model?.supportedReasoningEfforts?.length) return [...model.supportedReasoningEfforts];
  // Account catalogs are authoritative when they declare capabilities. Known
  // GPT-6 fallbacks follow published model support, never the Codex UI's aliases.
  if (/^gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$)/iu.test(model?.id ?? "")) {
    return /^gpt-6-(?:sol|luna)(?:-|$)/iu.test(model?.id ?? "")
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "xhigh", "max"];
  }
  return ["low", "medium", "high"];
}

export function chatGptSpeedLabel(tier: string): string {
  return tier === "default" || tier === "standard" ? "Standard"
    : tier === "fast" || tier === "priority" ? "Fast"
      : tier === "ultrafast" ? "Ultrafast" : "Unknown";
}
