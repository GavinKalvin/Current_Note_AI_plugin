export type ProviderRole = "system" | "user" | "assistant";
export type ProviderKind = "deepseek" | "kimi" | "kimi-code" | "chatgpt";
// Kept as an alias for adapter and v0.1.6 history compatibility.
export type ProviderId = ProviderKind;
export type ProfileId = string;
export type ProviderEndpointId = "deepseek-official" | "kimi-cn" | "kimi-global" | "kimi-code-local" | "chatgpt-plan";
export type ChatGptReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGptServiceTier = "standard" | "fast";
/** Requested reasoning setting frozen for this answer; never hidden chain of thought. */
export type MessageReasoning = ChatGptReasoningEffort | "off";

export interface ModelRef {
  providerId: ProviderId;
  modelId: string;
}

export interface ProfileModelRef {
  profileId: ProfileId;
  modelId: string;
}

export interface ProviderMessage {
  role: ProviderRole;
  content: string;
}

export interface CompletionOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
  responseFormat: "text" | "json";
  reasoningEffort?: Exclude<ChatGptReasoningEffort, "auto">;
  serviceTier?: "default" | "fast";
}

export interface CompletionRequest {
  messages: ProviderMessage[];
  options: CompletionOptions;
}

export interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  visibleOutputTokens?: number;
  totalTokens?: number;
}

export interface CompletionResponse {
  content: string;
  finishReason: string;
  usage?: CompletionUsage;
  actualServiceTier?: string;
}

export interface ProviderModel {
  id: string;
  displayName?: string;
  /** Explicit user-requested model absent from the live account catalog. */
  catalogSource?: "manual";
  ownedBy?: string;
  contextWindowTokens?: number;
  supportsReasoning?: boolean;
  supportedReasoningEfforts?: Exclude<ChatGptReasoningEffort, "auto">[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  listModels(apiKey: string): Promise<ProviderModel[]>;
  complete(apiKey: string, request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
}

export interface ProviderModelCatalog {
  models: ProviderModel[];
  lastSuccessfulRefreshAt: number;
}

export interface ProviderProfile {
  id: ProfileId;
  label: string;
  providerId: ProviderId;
  endpointId: ProviderEndpointId;
  secretId: string;
  /** Absolute official Kimi Code executable path; blank enables discovery. */
  cliPath?: string;
  /** Non-secret account identity for official ChatGPT plan OAuth. */
  chatgptAccountId?: string;
  chatgptReasoningEffort?: ChatGptReasoningEffort;
  chatgptSpeed?: ChatGptServiceTier;
  enabled: boolean;
  revision: number;
  catalog: ProviderModelCatalog;
}

export interface FrozenRequestTarget {
  profileId: ProfileId;
  profileRevision: number;
  providerId: ProviderId;
  modelId: string;
}

export interface ProviderConsentGrant {
  disclosureRevision: number;
  acceptedAt: number;
}

export interface ProfileConsentGrant extends ProviderConsentGrant {
  profileRevision: number;
  providerId: ProviderId;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  requestKind?: "discussion" | "edit";
  finishReason?: string;
  generationState?: "complete" | "incomplete";
  usage?: CompletionUsage;
  noteHash?: string;
  continuationCount?: number;
  providerId?: ProviderId;
  modelId?: string;
  target?: FrozenRequestTarget;
  actualServiceTier?: string;
  origin?: "ai" | "local";
  reasoning?: MessageReasoning;
}

export interface SavedConversation {
  id: string;
  title: string;
  notePath: string;
  noteName: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface DocumentSnapshot {
  text: string;
  hash: string;
  filePath: string;
  capturedAt: number;
}

export interface EditOperationInput {
  id: string;
  oldText: string;
  newText: string;
  reason: string;
}

export interface EditProposalPayload {
  schemaVersion: 1 | 2;
  status?: "complete";
  summary: string;
  coveredTargets?: string[];
  uncoveredTargets?: string[];
  operations: EditOperationInput[];
}

export interface ValidatedEditOperation extends EditOperationInput {
  start: number;
  end: number;
}

export interface EditProposalCandidate {
  summary: string;
  operations: ValidatedEditOperation[];
  baseText: string;
  baseHash: string;
  changedCharacters: number;
  changeRatio: number;
}

export interface EditProposalLimits {
  maxOperations: number;
  maxChangeRatio: number;
  maxFieldCharacters: number;
}
