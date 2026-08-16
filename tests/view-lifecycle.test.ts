import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { hashText } from "../src/core/hash";
import type { ModelRef, ProviderAdapter } from "../src/types";
import { CurrentNoteAiView } from "../src/view";

function createView(options: {
  persistFails?: boolean;
  noteText?: string;
  selectedModel?: ModelRef;
} = {}) {
  const noteText = options.noteText ?? "before";
  const editor = {
    value: noteText,
    getValue() {
      return this.value;
    },
    offsetToPos: vi.fn(() => ({ line: 0, ch: 6 })),
    transaction: vi.fn(function transaction(this: typeof editor, change: {
      changes: Array<{ text: string }>;
    }) {
      this.value = change.changes[0]?.text ?? this.value;
    }),
  };
  const editorView = new MarkdownView({} as never);
  Object.assign(editorView, { editor, file: { path: "note.md", basename: "note" } });
  const leaf = { view: editorView };
  const deepseek = {
    id: "deepseek",
    displayName: "DeepSeek",
    listModels: vi.fn(async () => [{ id: "deepseek-v4-flash", contextWindowTokens: 64_000 }]),
    complete: vi.fn(async () => ({ content: "DeepSeek response", finishReason: "stop" })),
  } satisfies ProviderAdapter;
  const kimi = {
    id: "kimi",
    displayName: "Kimi",
    listModels: vi.fn(async () => [{ id: "kimi-k2.6", contextWindowTokens: 256_000 }]),
    complete: vi.fn(async () => ({ content: "Kimi response", finishReason: "stop" })),
  } satisfies ProviderAdapter;
  const selectedModel = options.selectedModel ?? { providerId: "deepseek", modelId: "deepseek-v4-flash" };
  const plugin = {
    settings: {
      schemaVersion: 2,
      selectedModel,
      kimiSecretId: "kimi-secret",
      providerCatalogs: {
        deepseek: {
          models: [{ id: "deepseek-v4-flash", contextWindowTokens: 64_000 }],
          lastSuccessfulRefreshAt: 1,
        },
        kimi: {
          models: [{ id: "kimi-k2.6", contextWindowTokens: 256_000 }],
          lastSuccessfulRefreshAt: 1,
        },
      },
      providerConsents: {
        deepseek: { disclosureRevision: 1, acceptedAt: 1 },
        kimi: { disclosureRevision: 1, acceptedAt: 1 },
      },
      secretId: "deepseek-secret",
      conversationHistory: [],
      model: "deepseek-v4-flash",
      availableModels: ["deepseek-v4-flash"],
      maxTokens: 4_096,
      temperature: 0.3,
      maxOperations: 20,
      maxChangeRatio: 0.5,
      consentAcknowledged: true,
    },
    hasPendingSave: true,
    documentGate: {
      assertCurrent: vi.fn(() => editorView),
      getCurrent: vi.fn(() => null),
      capture: vi.fn(() => ({
        text: editor.value,
        hash: hashText(editor.value),
        filePath: "note.md",
        capturedAt: 1,
      })),
    },
    upsertConversation: vi.fn(async () => {
      if (options.persistFails ?? true) throw new Error("disk full");
    }),
    providers: { deepseek, kimi },
    resolveRequestContext: vi.fn((model: ModelRef = selectedModel) => {
      const adapter = model.providerId === "kimi" ? kimi : deepseek;
      return {
        model,
        adapter,
        displayName: adapter.displayName,
        contextWindowTokens: model.providerId === "kimi" ? 256_000 : 64_000,
      };
    }),
    getApiKey: vi.fn((providerId: "deepseek" | "kimi") => `${providerId}-secret`),
    saveSettings: vi.fn(async () => undefined),
  };
  const view = new CurrentNoteAiView(leaf as never, plugin as never);
  const bound = {
    leaf,
    file: (editorView as never as { file: object }).file,
    filePath: "note.md",
  };
  Object.assign(view as object, { bound });
  return { view, editor, editorView, plugin, deepseek, kimi };
}

describe("CurrentNoteAiView lifecycle hardening", () => {
  it("does not rebuild the full view for editor content changes", () => {
    const { view, editorView } = createView();
    const render = vi.spyOn(view as never, "render");
    const refresh = vi.spyOn(view as never, "refreshLiveEditState").mockImplementation(() => undefined);

    view.handleEditorContentChanged(editorView);

    expect(refresh).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
  });

  it("does not rebuild when an active-leaf event keeps the same main-note identity", () => {
    const { view } = createView();
    const render = vi.spyOn(view as never, "render");

    view.handleWorkspaceContextChanged();

    expect(render).not.toHaveBeenCalled();
  });

  it("reports persistence failure without misreporting the applied editor transaction", async () => {
    const { view, editor } = createView();
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    const proposal = {
      candidate: {
        summary: "Replace text",
        operations: [{
          id: "edit-1",
          oldText: "before",
          newText: "after",
          reason: "test",
          start: 0,
          end: 6,
        }],
        baseText: "before",
        baseHash: hashText("before"),
        changedCharacters: 6,
        changeRatio: 1,
      },
      snapshot: {
        text: "before",
        hash: hashText("before"),
        filePath: "note.md",
        capturedAt: 1,
      },
      selectedIds: new Set(["edit-1"]),
      request: "replace",
    };

    await (view as never as { applyProposal(value: typeof proposal): Promise<void> })
      .applyProposal(proposal);

    expect(editor.value).toBe("after");
    expect(editor.transaction).toHaveBeenCalledOnce();
    expect((view as never as { pendingProposal: unknown }).pendingProposal).toBeNull();
    expect((view as never as { lastApplied: unknown }).lastApplied).not.toBeNull();
    expect((view as never as { errorMessage: string }).errorMessage)
      .toContain("note was modified successfully");

    await (view as never as { applyProposal(value: typeof proposal): Promise<void> })
      .applyProposal(proposal);
    expect(editor.transaction).toHaveBeenCalledOnce();
  });

  it("blocks an over-budget request before invoking the provider", async () => {
    const { view, deepseek, kimi } = createView({
      persistFails: false,
      noteText: "x".repeat(300_000),
    });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    Object.assign(view as object, { draft: "Analyze this note" });

    await (view as never as { sendDiscussion(): Promise<void> }).sendDiscussion();

    expect(deepseek.complete).not.toHaveBeenCalled();
    expect(kimi.complete).not.toHaveBeenCalled();
    expect((view as never as { errorMessage: string }).errorMessage)
      .toContain("above the conservative 64,000-token context limit");
  });

  it("routes discussion to Kimi when the structured selected model is Kimi", async () => {
    const { view, plugin, deepseek, kimi } = createView({
      persistFails: false,
      selectedModel: { providerId: "kimi", modelId: "kimi-k2.6" },
    });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    Object.assign(view as object, { draft: "Analyze this note" });

    await (view as never as { sendDiscussion(): Promise<void> }).sendDiscussion();

    expect(kimi.complete).toHaveBeenCalledOnce();
    expect(deepseek.complete).not.toHaveBeenCalled();
    expect(plugin.getApiKey).toHaveBeenCalledWith("kimi");
    expect(plugin.upsertConversation).toHaveBeenCalled();
  });

  it("continues an incomplete DeepSeek response with its original model after switching to Kimi", async () => {
    const { view, plugin, deepseek, kimi } = createView({
      persistFails: false,
      selectedModel: { providerId: "kimi", modelId: "kimi-k2.6" },
    });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    const incomplete = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "A partial DeepSeek answer",
      createdAt: 1,
      requestKind: "discussion" as const,
      finishReason: "length",
      generationState: "incomplete" as const,
      noteHash: hashText("before"),
      continuationCount: 0,
      providerId: "deepseek" as const,
      modelId: "deepseek-v4-flash",
    };
    Object.assign(view as object, { messages: [incomplete] });
    deepseek.complete.mockResolvedValueOnce({
      content: "A partial DeepSeek answer with continuation",
      finishReason: "stop",
    });

    await (view as never as { continueDiscussion(message: typeof incomplete): Promise<void> })
      .continueDiscussion(incomplete);

    expect(deepseek.complete).toHaveBeenCalledOnce();
    expect(kimi.complete).not.toHaveBeenCalled();
    expect(plugin.resolveRequestContext).toHaveBeenCalledWith({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    expect(plugin.getApiKey).toHaveBeenCalledWith("deepseek");
  });
});
