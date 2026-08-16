export type ProviderRole = "system" | "user" | "assistant";
export type ProviderKind = "deepseek" | "kimi";
// Kept as an alias for adapter and v0.1.6 history compatibility.
export type ProviderId = ProviderKind;
export type ProfileId = string;
export type ProviderEndpointId = "deepseek-official" | "kimi-cn" | "kimi-global";

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
}

export interface ProviderModel {
  id: string;
  ownedBy?: string;
  contextWindowTokens?: number;
  supportsReasoning?: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  listModels(apiKey: string): Promise<ProviderModel[]>;
  complete(apiKey: string, request: CompletionRequest): Promise<CompletionResponse>;
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
