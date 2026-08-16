import type { ConversationMessage, SavedConversation } from "../types";

export const MAX_SAVED_CONVERSATIONS = 50;
export const MAX_SAVED_CONVERSATION_BYTES = 5 * 1024 * 1024;
export const MAX_SAVED_HISTORY_BYTES = 20 * 1024 * 1024;
const MAX_SAVED_MESSAGES = 200;
const MAX_TITLE_CHARACTERS = 36;
const LEGACY_OUTPUT_LIMIT_SUFFIX = "\n\n[Response stopped because the output limit was reached.]";
const MAX_PROFILE_ID_LENGTH = 200;
const MAX_PROFILE_REVISION = 1_000_000;

export function createConversationTitle(content: string, fallbackNoteName: string): string {
  const normalized = content
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/[*_`~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const fallback = fallbackNoteName.trim()
    ? `关于 ${fallbackNoteName.trim()}`
    : "新对话";
  if (!normalized) return truncateTitle(fallback);
  return truncateTitle(normalized);
}

export function sanitizeConversationHistory(value: unknown): SavedConversation[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const conversations: SavedConversation[] = [];
  for (const candidate of value) {
    const conversation = sanitizeConversation(candidate);
    if (!conversation || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    conversations.push(conversation);
  }

  const sorted = conversations
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SAVED_CONVERSATIONS);
  const bounded: SavedConversation[] = [];
  let totalBytes = 0;
  for (const conversation of sorted) {
    const bytes = serializedBytes(conversation);
    if (totalBytes + bytes > MAX_SAVED_HISTORY_BYTES) break;
    bounded.push(conversation);
    totalBytes += bytes;
  }
  return bounded;
}

export function upsertConversationHistory(
  history: readonly SavedConversation[],
  conversation: SavedConversation,
): SavedConversation[] {
  return sanitizeConversationHistory([
    conversation,
    ...history.filter((item) => item.id !== conversation.id),
  ]);
}

export function renameConversationHistoryNote(
  history: readonly SavedConversation[],
  oldPath: string,
  newPath: string,
  newName: string,
): { history: SavedConversation[]; changed: boolean } {
  let changed = false;
  const renamed = history.map((conversation) => {
    if (conversation.notePath !== oldPath) return conversation;
    changed = true;
    return {
      ...conversation,
      notePath: newPath,
      noteName: newName,
    };
  });
  return { history: renamed, changed };
}

function sanitizeConversation(value: unknown): SavedConversation | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id, 160);
  const title = readString(value.title, 200);
  const notePath = readString(value.notePath, 2_000, true);
  const noteName = readString(value.noteName, 300, true);
  const createdAt = readTimestamp(value.createdAt);
  const updatedAt = readTimestamp(value.updatedAt);
  if (!id || !title || createdAt === null || updatedAt === null) return null;
  if (!Array.isArray(value.messages)) return null;

  const sanitizedMessages = value.messages
    .map(sanitizeMessage)
    .filter((message): message is ConversationMessage => message !== null)
    .slice(-MAX_SAVED_MESSAGES);
  const messages: ConversationMessage[] = [];
  let messageBytes = 0;
  for (const message of sanitizedMessages.slice().reverse()) {
    const bytes = serializedBytes(message);
    if (messageBytes + bytes > MAX_SAVED_CONVERSATION_BYTES) break;
    messages.push(message);
    messageBytes += bytes;
  }
  messages.reverse();
  if (messages.length === 0) return null;

  return {
    id,
    title,
    notePath: notePath ?? "",
    noteName: noteName ?? "",
    messages,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
  };
}

function sanitizeMessage(value: unknown): ConversationMessage | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id, 160);
  const content = readString(value.content, 500_000, true);
  const createdAt = readTimestamp(value.createdAt);
  const role = value.role;
  if (!id || content === null || createdAt === null) return null;
  if (role !== "user" && role !== "assistant") return null;
  const migratedLegacyLimit = role === "assistant" && content.endsWith(LEGACY_OUTPUT_LIMIT_SUFFIX);
  const sanitizedContent = migratedLegacyLimit
    ? content.slice(0, -LEGACY_OUTPUT_LIMIT_SUFFIX.length)
    : content;
  const requestKind = value.requestKind === "discussion" || value.requestKind === "edit"
    ? value.requestKind
    : migratedLegacyLimit ? "discussion" : undefined;
  const finishReason = readString(value.finishReason, 100, true)
    ?? (migratedLegacyLimit ? "length" : undefined);
  const generationState = value.generationState === "complete" || value.generationState === "incomplete"
    ? value.generationState
    : migratedLegacyLimit ? "incomplete" : undefined;
  const noteHash = readString(value.noteHash, 200, true) ?? undefined;
  const continuationCount = readNonNegativeInteger(value.continuationCount, 100);
  const usage = sanitizeUsage(value.usage);
  const providerId = value.providerId === "deepseek" || value.providerId === "kimi"
    ? value.providerId
    : undefined;
  const modelId = providerId === undefined ? undefined : readTrimmedString(value.modelId, 200);
  const target = sanitizeTarget(value.target)
    ?? (providerId !== undefined && modelId !== undefined
      ? legacyTarget(providerId, modelId)
      : undefined);

  return {
    id,
    role,
    content: sanitizedContent,
    createdAt,
    requestKind,
    finishReason,
    generationState,
    noteHash,
    continuationCount,
    usage,
    ...(providerId === undefined ? {} : { providerId, ...(modelId === undefined ? {} : { modelId }) }),
    ...(target === undefined ? {} : { target }),
  };
}

function sanitizeTarget(value: unknown): ConversationMessage["target"] {
  if (!isRecord(value)) return undefined;
  const profileId = readTrimmedString(value.profileId, MAX_PROFILE_ID_LENGTH);
  const profileRevision = readPositiveInteger(value.profileRevision, MAX_PROFILE_REVISION);
  const providerId = value.providerId === "deepseek" || value.providerId === "kimi"
    ? value.providerId
    : undefined;
  const modelId = readTrimmedString(value.modelId, 200);
  if (profileId === undefined || profileRevision === undefined || providerId === undefined || modelId === undefined) {
    return undefined;
  }
  return { profileId, profileRevision, providerId, modelId };
}

function legacyTarget(
  providerId: "deepseek" | "kimi",
  modelId: string,
): ConversationMessage["target"] {
  return {
    profileId: providerId === "deepseek" ? "legacy-deepseek" : "legacy-kimi",
    profileRevision: 1,
    providerId,
    modelId,
  };
}

function sanitizeUsage(value: unknown): ConversationMessage["usage"] {
  if (!isRecord(value)) return undefined;
  const usage = {
    promptTokens: readNonNegativeNumber(value.promptTokens),
    completionTokens: readNonNegativeNumber(value.completionTokens),
    reasoningTokens: readNonNegativeNumber(value.reasoningTokens),
    visibleOutputTokens: readNonNegativeNumber(value.visibleOutputTokens),
    totalTokens: readNonNegativeNumber(value.totalTokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function truncateTitle(value: string): string {
  if (value.length <= MAX_TITLE_CHARACTERS) return value;
  return `${value.slice(0, MAX_TITLE_CHARACTERS - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
}

function readTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readNonNegativeInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
