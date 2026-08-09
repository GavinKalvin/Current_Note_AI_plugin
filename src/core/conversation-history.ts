import type { ConversationMessage, SavedConversation } from "../types";

export const MAX_SAVED_CONVERSATIONS = 50;
const MAX_SAVED_MESSAGES = 200;
const MAX_TITLE_CHARACTERS = 36;

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

  return conversations
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SAVED_CONVERSATIONS);
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

  const messages = value.messages
    .map(sanitizeMessage)
    .filter((message): message is ConversationMessage => message !== null)
    .slice(-MAX_SAVED_MESSAGES);
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
  return { id, role, content, createdAt };
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

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
