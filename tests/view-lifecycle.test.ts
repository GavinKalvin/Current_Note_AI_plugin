import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { hashText } from "../src/core/hash";
import type { CompletionOptions, CompletionRequest, FrozenRequestTarget, ModelRef, ProfileModelRef, ProviderAdapter, ProviderProfile } from "../src/types";
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
  const profiles: ProviderProfile[] = [
    {
      id: "legacy-deepseek", label: "DeepSeek", providerId: "deepseek", endpointId: "deepseek-official", secretId: "deepseek-secret", enabled: true, revision: 1,
      catalog: { models: [{ id: "deepseek-v4-flash", contextWindowTokens: 64_000 }], lastSuccessfulRefreshAt: 1 },
    },
    {
      id: "legacy-kimi", label: "Kimi", providerId: "kimi", endpointId: "kimi-cn", secretId: "kimi-secret", enabled: true, revision: 1,
      catalog: { models: [{ id: "kimi-k2.6", contextWindowTokens: 256_000 }], lastSuccessfulRefreshAt: 1 },
    },
  ];
  const selectedProfileModel: ProfileModelRef = {
    profileId: selectedModel.providerId === "kimi" ? "legacy-kimi" : "legacy-deepseek",
    modelId: selectedModel.modelId,
  };
  const plugin = {
    settings: {
      schemaVersion: 3,
      providerProfiles: profiles,
      selectedProfileModel,
      profileConsents: {
        "legacy-deepseek": { disclosureRevision: 1, acceptedAt: 1, profileRevision: 1, providerId: "deepseek" },
        "legacy-kimi": { disclosureRevision: 1, acceptedAt: 1, profileRevision: 1, providerId: "kimi" },
      },
      migrationVersion: 3,
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
    resolveRequestContext: vi.fn((model: ProfileModelRef | FrozenRequestTarget | ModelRef | null = selectedProfileModel) => {
      const profileId = model && "profileId" in model
        ? model.profileId
        : model && "providerId" in model && model.providerId === "kimi" ? "legacy-kimi" : "legacy-deepseek";
      const profile = profiles.find((candidate) => candidate.id === profileId) ?? profiles[0]!;
      const modelId = model && "modelId" in model ? model.modelId : selectedModel.modelId;
      const adapter = profile.providerId === "kimi" ? kimi : deepseek;
      const target = {
        profileId: profile.id,
        profileRevision: profile.revision,
        providerId: profile.providerId,
        modelId,
      } satisfies FrozenRequestTarget;
      return {
        profile,
        profileModel: { profileId: profile.id, modelId },
        target,
        model: { providerId: profile.providerId, modelId },
        adapter,
        displayName: adapter.displayName,
        destination: profile.providerId === "kimi" ? "https://api.moonshot.cn/v1" : "https://api.deepseek.com",
        contextWindowTokens: profile.providerId === "kimi" ? 256_000 : 64_000,
      };
    }),
    getApiKey: vi.fn((profileId: string) => profileId === "legacy-kimi" ? "kimi-secret" : "deepseek-secret"),
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
    expect(plugin.getApiKey).toHaveBeenCalledWith("legacy-kimi");
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
      target: {
        profileId: "legacy-deepseek",
        profileRevision: 1,
        providerId: "deepseek" as const,
        modelId: "deepseek-v4-flash",
      },
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
    expect(plugin.resolveRequestContext).toHaveBeenCalledWith(incomplete.target);
    expect(plugin.getApiKey).toHaveBeenCalledWith("legacy-deepseek");
    expect((view as never as { messages: Array<Record<string, unknown>> }).messages.at(-1)).toMatchObject({
      role: "assistant",
      origin: "ai",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoning: "off",
    });
  });

  it("records discussion provenance and reasoning from the request that was sent", async () => {
    const { view, deepseek } = createView({ persistFails: false });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    deepseek.complete.mockResolvedValueOnce({ content: "Answer", finishReason: "stop" });
    Object.assign(view as object, { draft: "Analyze this note" });

    await (view as never as { sendDiscussion(): Promise<void> }).sendDiscussion();

    expect((view as never as { messages: Array<Record<string, unknown>> }).messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Answer",
      origin: "ai",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoning: "off",
    });
  });

  it("freezes ChatGPT request metadata before awaiting a deferred provider response", async () => {
    const { view, plugin } = createView();
    let resolveResponse!: (value: { content: string; finishReason: string }) => void;
    const deferred = new Promise<{ content: string; finishReason: string }>((resolve) => {
      resolveResponse = resolve;
    });
    const profile = {
      id: "chatgpt-plan", providerId: "chatgpt", chatgptReasoningEffort: "high",
      catalog: { models: [{ id: "gpt-chosen" }] },
    } as unknown as ProviderProfile;
    const options: CompletionOptions = {
      model: "gpt-chosen", maxTokens: 100, responseFormat: "text", reasoningEffort: "high",
    };
    const request: CompletionRequest = { messages: [], options };
    const context = {
      profile,
      model: { providerId: "chatgpt" as const, modelId: "gpt-chosen" },
      adapter: { complete: vi.fn(() => deferred) },
    };
    const completeRequest = (view as never as {
      completeRequest(context: unknown, request: CompletionRequest): Promise<{
        generationMetadata: { origin: string; providerId: string; modelId: string; reasoning: string };
      }>;
    }).completeRequest.bind(view);

    const pending = completeRequest(context, request);
    options.model = "mutated-request-model";
    options.reasoningEffort = "none";
    profile.chatgptReasoningEffort = "max";
    profile.catalog.models[0]!.id = "mutated-profile-model";
    plugin.settings.selectedModel = { providerId: "kimi", modelId: "kimi-k2.6" };
    resolveResponse({ content: "done", finishReason: "stop" });

    await expect(pending).resolves.toMatchObject({
      generationMetadata: {
        origin: "ai", providerId: "chatgpt", modelId: "gpt-chosen", reasoning: "high",
      },
    });
  });

  it("records edit summaries and edit-retry results as AI generations", async () => {
    const noteText = `before-unique ${"x".repeat(120)}`;
    const { view, deepseek } = createView({ persistFails: false, noteText });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    const proposalResponse = {
      content: JSON.stringify({
        schemaVersion: 1,
        summary: "Replace opening word",
        operations: [{ id: "edit-one", oldText: "before-unique", newText: "after-unique", reason: "test" }],
      }),
      finishReason: "stop",
    };
    deepseek.complete.mockResolvedValueOnce(proposalResponse);
    Object.assign(view as object, { draft: "Replace the opening word" });

    await (view as never as { requestEditProposal(): Promise<void> }).requestEditProposal();

    expect((view as never as { messages: Array<Record<string, unknown>> }).messages.at(-1)).toMatchObject({
      content: "Replace opening word",
      origin: "ai",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoning: "off",
    });

    // A separate attempt first receives a length-limited response, then retries
    // against the frozen target and must retain the retry request provenance.
    const retryView = createView({ persistFails: false, noteText }).view;
    vi.spyOn(retryView as never, "render").mockImplementation(() => undefined);
    const retryProvider = (retryView as never as { plugin: { providers: { deepseek: ProviderAdapter } } }).plugin.providers.deepseek;
    retryProvider.complete = vi.fn()
      .mockResolvedValueOnce({ content: "partial", finishReason: "length" })
      .mockResolvedValueOnce(proposalResponse);
    Object.assign(retryView as object, { draft: "Replace the opening word" });
    await (retryView as never as { requestEditProposal(): Promise<void> }).requestEditProposal();
    const retry = (retryView as never as { editRetry: unknown }).editRetry;
    expect(retry).toBeTruthy();
    await (retryView as never as { retryEditProposal(value: unknown): Promise<void> }).retryEditProposal(retry);
    expect((retryView as never as { messages: Array<Record<string, unknown>> }).messages.at(-1)).toMatchObject({
      content: "Replace opening word",
      origin: "ai",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoning: "off",
    });
  });

  it("marks applied and reverted edit messages as local, not AI provider generations", async () => {
    const { view, editor } = createView({ persistFails: false });
    vi.spyOn(view as never, "render").mockImplementation(() => undefined);
    const proposal = {
      candidate: {
        summary: "Replace text",
        operations: [{ id: "edit-1", oldText: "before", newText: "after", reason: "test", start: 0, end: 6 }],
        baseText: "before", baseHash: hashText("before"), changedCharacters: 6, changeRatio: 1,
      },
      snapshot: { text: "before", hash: hashText("before"), filePath: "note.md", capturedAt: 1 },
      selectedIds: new Set(["edit-1"]),
      request: "replace",
    };
    await (view as never as { applyProposal(value: typeof proposal): Promise<void> }).applyProposal(proposal);
    await (view as never as { revertLastApplied(): Promise<void> }).revertLastApplied();

    expect(editor.value).toBe("before");
    const localMessages = (view as never as { messages: Array<Record<string, unknown>> }).messages
      .filter((message) => message.content === "Applied 1 reviewed edit." || message.content === "Reverted the last AI edit.");
    expect(localMessages).toHaveLength(2);
    for (const message of localMessages) {
      expect(message.origin).toBe("local");
      expect(message).not.toHaveProperty("providerId");
      expect(message).not.toHaveProperty("modelId");
      expect(message).not.toHaveProperty("reasoning");
    }
  });
});
