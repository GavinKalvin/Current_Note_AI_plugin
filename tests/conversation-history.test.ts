import { describe, expect, it } from "vitest";
import {
  createConversationTitle,
  MAX_SAVED_CONVERSATION_BYTES,
  MAX_SAVED_CONVERSATIONS,
  renameConversationHistoryNote,
  sanitizeConversationHistory,
  upsertConversationHistory,
} from "../src/core/conversation-history";
import type { SavedConversation } from "../src/types";

function conversation(id: string, updatedAt: number): SavedConversation {
  return {
    id,
    title: `Conversation ${id}`,
    notePath: "Notes/example.md",
    noteName: "example",
    messages: [{
      id: `message-${id}`,
      role: "user",
      content: `Message ${id}`,
      createdAt: updatedAt,
    }],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("createConversationTitle", () => {
  it("creates a compact local title from the first user message", () => {
    expect(createConversationTitle("  ## **总结**  当前笔记\n的重点  ", "示例"))
      .toBe("总结 当前笔记 的重点");
  });

  it("falls back to the note name and truncates long titles", () => {
    expect(createConversationTitle("", "刻蚀机理")).toBe("关于 刻蚀机理");
    const title = createConversationTitle("这是一个非常长而且需要被截断的自动会话标题，用于验证侧边栏不会被撑开".repeat(2), "");
    expect(title.length).toBeLessThanOrEqual(36);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("conversation history persistence", () => {
  it("sanitizes, deduplicates, sorts, and caps saved conversations", () => {
    const input = Array.from(
      { length: MAX_SAVED_CONVERSATIONS + 2 },
      (_, index) => conversation(String(index), index + 1),
    );
    input.push(conversation("10", 10));
    const result = sanitizeConversationHistory([...input, { broken: true }]);

    expect(result).toHaveLength(MAX_SAVED_CONVERSATIONS);
    expect(result[0]?.id).toBe(String(MAX_SAVED_CONVERSATIONS + 1));
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });

  it("moves an updated conversation to the front without duplicating it", () => {
    const result = upsertConversationHistory(
      [conversation("older", 10), conversation("active", 20)],
      conversation("older", 30),
    );

    expect(result.map((item) => item.id)).toEqual(["older", "active"]);
    expect(result).toHaveLength(2);
  });

  it("updates only conversations bound to a renamed note", () => {
    const original = [conversation("target", 20), conversation("other", 10)];
    original[0]!.notePath = "old.md";
    original[1]!.notePath = "other.md";

    const result = renameConversationHistoryNote(original, "old.md", "folder/new.md", "new");

    expect(result.changed).toBe(true);
    expect(result.history[0]).toMatchObject({ notePath: "folder/new.md", noteName: "new" });
    expect(result.history[1]).toBe(original[1]);
  });

  it("preserves safe generation metadata and migrates legacy limit warnings", () => {
    const input = conversation("legacy", 10);
    input.messages = [{
      id: "assistant-legacy",
      role: "assistant",
      content: "Partial answer\n\n[Response stopped because the output limit was reached.]",
      createdAt: 10,
      usage: {
        promptTokens: 100,
        completionTokens: 4_096,
        reasoningTokens: 1_024,
        visibleOutputTokens: 3_072,
        totalTokens: 4_196,
      },
    }];

    const message = sanitizeConversationHistory([input])[0]?.messages[0];

    expect(message?.content).toBe("Partial answer");
    expect(message?.finishReason).toBe("length");
    expect(message?.generationState).toBe("incomplete");
    expect(message?.requestKind).toBe("discussion");
    expect(message?.usage?.reasoningTokens).toBe(1_024);
  });

  it("preserves valid provider source metadata through sanitize and upsert", () => {
    const saved = conversation("source", 10);
    saved.messages[0] = {
      ...saved.messages[0]!,
      role: "assistant",
      providerId: "kimi",
      modelId: "  kimi-k2.6  ",
    };

    const sanitized = sanitizeConversationHistory([saved]);
    expect(sanitized[0]?.messages[0]).toMatchObject({ providerId: "kimi", modelId: "kimi-k2.6" });

    const upserted = upsertConversationHistory([], saved);
    expect(upserted[0]?.messages[0]).toMatchObject({ providerId: "kimi", modelId: "kimi-k2.6" });
  });

  it("drops malformed provider source metadata without affecting the message", () => {
    const saved = conversation("invalid-source", 10);
    saved.messages[0] = {
      ...saved.messages[0]!,
      providerId: "openai" as never,
      modelId: ` ${"x".repeat(201)} `,
    };

    const [result] = sanitizeConversationHistory([saved]);
    expect(result?.messages[0]).not.toHaveProperty("providerId");
    expect(result?.messages[0]).not.toHaveProperty("modelId");
    expect(result?.messages[0]?.content).toBe("Message invalid-source");
  });

  it("keeps providerId but drops a missing or invalid modelId", () => {
    const saved = conversation("provider-only", 10);
    saved.messages[0] = {
      ...saved.messages[0]!,
      providerId: "deepseek",
      modelId: "   ",
    };

    const [result] = sanitizeConversationHistory([saved]);
    expect(result?.messages[0]).toMatchObject({ providerId: "deepseek" });
    expect(result?.messages[0]).not.toHaveProperty("modelId");
  });

  it("bounds the serialized size of one saved conversation", () => {
    const oversized = conversation("large", 10);
    oversized.messages = Array.from({ length: 12 }, (_, index) => ({
      id: `large-${index}`,
      role: "assistant" as const,
      content: "x".repeat(500_000),
      createdAt: index + 1,
    }));

    const [sanitized] = sanitizeConversationHistory([oversized]);
    expect(sanitized).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(sanitized)).byteLength)
      .toBeLessThanOrEqual(MAX_SAVED_CONVERSATION_BYTES);
    expect(sanitized?.messages.length).toBeLessThan(oversized.messages.length);
  });
});
