import { describe, expect, it, vi } from "vitest";
import { copyMessageText } from "../src/core/message-copy";

describe("copyMessageText", () => {
  it("writes the exact original Markdown and math source", async () => {
    const source = ["**Bold**", "", "$x^2$", "\\[\\frac{1}{2}\\]"].join("\n");
    const writeText = vi.fn(async (_text: string) => undefined);

    await copyMessageText(source, { writeText });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(source);
  });

  it("rejects clearly when clipboard access is unavailable", async () => {
    const source = "private message content";

    const error = await copyMessageText(source, undefined).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(source);
  });

  it("surfaces clipboard write failures without including message text", async () => {
    const source = "private message content";
    const writeText = vi.fn(async () => {
      throw new Error("permission denied");
    });

    const error = await copyMessageText(source, { writeText }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(source);
  });
});
