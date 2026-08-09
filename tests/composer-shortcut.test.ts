import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "../src/core/composer-shortcut";

describe("shouldSubmitComposer", () => {
  it.each([
    { name: "Enter", event: { key: "Enter" } },
    { name: "Command+Enter", event: { key: "Enter", metaKey: true } },
    { name: "Control+Enter", event: { key: "Enter", ctrlKey: true } },
    { name: "numpad Enter", event: { key: "Unidentified", code: "NumpadEnter" } },
    { name: "legacy Electron Enter", event: { key: "Unidentified", keyCode: 13 } },
  ])("submits on $name", ({ event }) => {
    expect(shouldSubmitComposer(event)).toBe(true);
  });

  it("keeps Shift+Enter as a newline", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does not submit while an input method is composing text", () => {
    expect(shouldSubmitComposer({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", keyCode: 229 })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(shouldSubmitComposer({ key: "a", code: "KeyA" })).toBe(false);
  });
});
