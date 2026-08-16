export type ProviderRole = "system" | "user" | "assistant";
export type ProviderId = "deepseek" | "kimi";

export interface ModelRef {
  providerId: ProviderId;
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

export interface ProviderConsentGrant {
  disclosureRevision: number;
  acceptedAt: number;
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
