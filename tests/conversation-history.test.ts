import { describe, expect, it } from "vitest";
import {
  createConversationTitle,
  MAX_SAVED_CONVERSATIONS,
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
});
