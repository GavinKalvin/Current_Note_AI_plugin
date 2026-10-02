import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { compileSelectedOperations, EditProposalError, validateEditProposal } from "./core/edit-proposal";
import { createConversationTitle } from "./core/conversation-history";
import {
  MAX_DISCUSSION_CONTINUATIONS,
  nextEditRetryBudget,
  trimExactContinuationOverlap,
} from "./core/completion";
import { shouldSubmitComposer } from "./core/composer-shortcut";
import { renderAssistantMarkdown } from "./core/markdown-rendering";
import { appendMathStyles } from "./core/math-styles";
import { copyMessageText } from "./core/message-copy";
import { captureGenerationMetadata, formatMessageDateTime, reasoningLabel } from "./core/message-metadata";
import type { GenerationMetadata } from "./core/message-metadata";
import { evaluateRequestBudget } from "./core/request-budget";
import {
  buildDiscussionContinuationMessages,
  buildDiscussionMessages,
  buildEditMessages,
} from "./core/prompt";
import type { BoundMarkdownDocument } from "./context";
import { CurrentDocumentError } from "./context";
import { FullNoteConsentModal } from "./modals";
import { ProviderRequestError } from "./provider/errors";
import type CurrentNoteAiPlugin from "./main";
import { chatGptEffortChoices, chatGptSpeedLabel } from "./core/chatgpt-options";
import type { ProviderRequestContext } from "./main";
import type {
  CompletionOptions,
  CompletionRequest,
  CompletionResponse,
  ChatGptReasoningEffort,
  ChatGptServiceTier,
  ConversationMessage,
  DocumentSnapshot,
  EditProposalCandidate,
  FrozenRequestTarget,
  ProfileModelRef,
  ProviderMessage,
  SavedConversation,
} from "./types";
import { PROVIDER_PRESETS, sameProfileModel } from "./core/provider-profiles";

export const CURRENT_NOTE_AI_VIEW = "current-note-ai-view";
const MAX_DOCUMENT_CHARACTERS = 1_500_000;

interface PendingProposal {
  candidate: EditProposalCandidate;
  snapshot: DocumentSnapshot;
  selectedIds: Set<string>;
  request: string;
}

interface EditRetryState {
  snapshot: DocumentSnapshot;
  history: ConversationMessage[];
  request: string;
  maxTokensUsed: number;
  nextMaxTokens: number | null;
  retryAttempted: boolean;
  reason: string;
  target: FrozenRequestTarget;
}

interface AppliedChange {
  binding: BoundMarkdownDocument;
  beforeText: string;
  afterText: string;
}

export class CurrentNoteAiView extends ItemView {
  private bound: BoundMarkdownDocument | null = null;
  private messages: ConversationMessage[] = [];
  private pendingProposal: PendingProposal | null = null;
  private editRetry: EditRetryState | null = null;
  private lastApplied: AppliedChange | null = null;
  private draft = "";
  private errorMessage = "";
  private busy = false;
  private modelLoading = false;
  private activeRequestProviderName = "AI provider";
  private requestAbort: AbortController | null = null;
  private activeRequestProfileId: string | null = null;
  private historyOpen = false;
  private activeConversationId: string | null = null;
  private activeConversationTitle = "";
  private activeConversationCreatedAt = 0;
  private activeConversationNotePath = "";
  private activeConversationNoteName = "";
  private requestGeneration = 0;
  private messageSequence = 0;
  private timelineEl: HTMLElement | null = null;
  private proposalStatusEl: HTMLElement | null = null;
  private proposalApplyButton: HTMLButtonElement | null = null;
  private revertButton: HTMLButtonElement | null = null;
  private renderedMessageCount = 0;
  private readonly messageHtmlCache = new Map<string, { source: string; html: string }>();
  private pendingScrollTimer: { window: Window; id: number } | null = null;
  private observedCurrentLeaf: WorkspaceLeaf | null = null;
  private observedCurrentFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CurrentNoteAiPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CURRENT_NOTE_AI_VIEW;
  }

  getDisplayText(): string {
    return "Current Note AI";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    if (!this.bound) this.bound = this.plugin.documentGate.getCurrent();
    this.addAction("refresh-cw", "Bind to current Markdown note", () => {
      this.bindToCurrent();
    });
    this.addAction("trash-2", "Clear in-memory conversation", () => {
      this.clearConversation();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.requestGeneration += 1;
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.clearPendingScrollTimer();
    this.messages = [];
    this.messageHtmlCache.clear();
    this.pendingProposal = null;
    this.editRetry = null;
    this.lastApplied = null;
    this.activeConversationId = null;
  }

  handleWorkspaceContextChanged(): void {
    if (!this.contentEl.isConnected) return;
    const current = this.plugin.documentGate.getCurrent();
    if (
      (current?.leaf ?? null) === this.observedCurrentLeaf
      && (current?.file ?? null) === this.observedCurrentFile
    ) return;
    this.render();
  }

  handleProfileSignedOut(profileId: string): void {
    if (this.activeRequestProfileId === profileId) {
      this.requestGeneration += 1;
      this.requestAbort?.abort();
      this.requestAbort = null;
      this.activeRequestProfileId = null;
      this.busy = false;
      this.errorMessage = "The ChatGPT session was signed out. The response will be ignored.";
    }
    this.render();
  }

  handleEditorContentChanged(editorView: MarkdownView): void {
    if (!this.contentEl.isConnected || this.bound?.leaf.view !== editorView) return;
    this.refreshLiveEditState();
  }

  handleNoteRenamed(file: TFile, oldPath: string): void {
    let changed = false;
    if (this.bound?.file === file && this.bound.filePath === oldPath) {
      this.bound = { ...this.bound, filePath: file.path };
      changed = true;
    }
    if (this.activeConversationNotePath === oldPath) {
      this.activeConversationNotePath = file.path;
      this.activeConversationNoteName = file.basename;
      changed = true;
    }
    if (changed && this.contentEl.isConnected) this.render();
  }

  private render(): void {
    const { contentEl } = this;
    const previousTimeline = this.timelineEl;
    const previousScrollTop = previousTimeline?.scrollTop ?? 0;
    const wasNearBottom = previousTimeline
      ? previousTimeline.scrollHeight - previousTimeline.scrollTop - previousTimeline.clientHeight < 48
      : true;
    const appendedMessages = this.messages.length > this.renderedMessageCount;
    this.clearPendingScrollTimer();
    contentEl.empty();
    contentEl.addClass("current-note-ai-view");
    appendMathStyles(contentEl);
    this.proposalStatusEl = null;
    this.proposalApplyButton = null;
    this.revertButton = null;

    this.renderHeader(contentEl);
    if (this.historyOpen) this.renderHistoryPanel(contentEl);
    this.renderContextBar(contentEl);

    if (this.hasHistoryBindingMismatch()) {
      contentEl.createDiv({
        cls: "current-note-ai-warning",
        text: `This conversation belongs to “${this.activeConversationNoteName || this.activeConversationNotePath}”. Open that note and bind it before continuing.`,
      });
    }

    if (this.errorMessage) {
      contentEl.createDiv({
        cls: "current-note-ai-error",
        text: this.errorMessage,
        attr: { role: "alert", "aria-live": "assertive" },
      });
    }

    const timeline = contentEl.createDiv({ cls: "current-note-ai-timeline" });
    this.timelineEl = timeline;
    if (this.messages.length === 0 && !this.pendingProposal && !this.editRetry) {
      const empty = timeline.createDiv({ cls: "current-note-ai-empty" });
      empty.createDiv({ cls: "current-note-ai-empty-icon", text: "✦" });
      empty.createEl("strong", { text: "Discuss the note in front of you" });
      empty.createEl("p", {
        text: "Send a question for analysis, or request a reviewed edit proposal. Nothing is written until you apply it.",
      });
    }

    for (const message of this.messages) this.renderMessage(timeline, message);
    if (this.busy) this.renderTypingBubble(timeline);
    if (this.editRetry) this.renderEditRetry(timeline, this.editRetry);
    if (this.pendingProposal) this.renderProposal(timeline, this.pendingProposal);

    this.renderComposer(contentEl);
    this.renderedMessageCount = this.messages.length;
    const targetWindow = contentEl.win;
    const timerId = targetWindow.setTimeout(() => {
      if (!timeline.isConnected) return;
      if (appendedMessages || wasNearBottom) {
        timeline.scrollTop = timeline.scrollHeight;
      } else {
        timeline.scrollTop = Math.min(previousScrollTop, timeline.scrollHeight);
      }
      this.pendingScrollTimer = null;
    });
    this.pendingScrollTimer = { window: targetWindow, id: timerId };
  }

  private clearPendingScrollTimer(): void {
    if (!this.pendingScrollTimer) return;
    this.pendingScrollTimer.window.clearTimeout(this.pendingScrollTimer.id);
    this.pendingScrollTimer = null;
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "current-note-ai-header" });
    const title = header.createDiv({ cls: "current-note-ai-brand" });
    const titleRow = title.createDiv({ cls: "current-note-ai-title-row" });
    titleRow.createEl("strong", { text: "Current Note AI" });
    titleRow.createSpan({
      cls: "current-note-ai-version",
      text: `v${this.plugin.manifest.version}`,
      attr: { title: "Loaded plugin version" },
    });
    const historyButton = titleRow.createEl("button", {
      cls: this.historyOpen
        ? "current-note-ai-history-button is-open"
        : "current-note-ai-history-button",
      attr: {
        "aria-expanded": String(this.historyOpen),
        title: "Show saved conversations",
      },
    });
    historyButton.createSpan({ text: "History" });
    const historyCount = this.plugin.settings.conversationHistory.length;
    if (historyCount > 0) {
      historyButton.createSpan({
        cls: "current-note-ai-history-count",
        text: String(historyCount),
      });
    }
    historyButton.disabled = this.busy;
    historyButton.addEventListener("click", () => {
      this.historyOpen = !this.historyOpen;
      this.render();
    });
    const modelBar = title.createDiv({ cls: "current-note-ai-model-bar" });
    modelBar.createSpan({ cls: "current-note-ai-provider", text: "Model" });

    const modelSelect = modelBar.createEl("select", {
      cls: "current-note-ai-model-select",
      attr: {
        "aria-label": "AI model",
        title: "Model used for the next AI request",
      },
    });
    const optionModels = new Map<string, ProfileModelRef>();
    let selectedOption = "";
    let optionSequence = 0;
    for (const profile of this.plugin.settings.providerProfiles) {
      if (!profile.enabled) continue;
      const group = modelSelect.createEl("optgroup", {
        attr: { label: `${profile.label} · ${PROVIDER_PRESETS[profile.providerId].displayName}` },
      });
      const catalogModels = profile.catalog.models;
      const selected = this.plugin.settings.selectedProfileModel?.profileId === profile.id
        ? this.plugin.settings.selectedProfileModel
        : null;
      const models = [...catalogModels];
      if (selected && !models.some((model) => model.id === selected.modelId)) {
        models.unshift({ id: selected.modelId });
      }
      for (const model of models) {
        const ref = { profileId: profile.id, modelId: model.id } satisfies ProfileModelRef;
        const optionKey = `model-${optionSequence++}`;
        optionModels.set(optionKey, ref);
        const unavailable = !catalogModels.some((candidate) => candidate.id === model.id);
        const option = group.createEl("option", {
          text: unavailable ? `${model.displayName ?? model.id} (unavailable)`
            : model.catalogSource === "manual" ? `${model.displayName ?? model.id} (manual · access unverified)` : model.displayName ?? model.id,
          value: optionKey,
        });
        option.disabled = unavailable;
        if (this.sameProfileModel(ref, this.plugin.settings.selectedProfileModel)) {
          selectedOption = optionKey;
        }
      }
    }
    modelSelect.value = selectedOption;
    modelSelect.disabled = this.busy || this.modelLoading || optionModels.size === 0;
    modelSelect.addEventListener("change", () => {
      const selected = optionModels.get(modelSelect.value);
      if (selected) void this.chooseModel(selected);
    });

    const refreshModels = modelBar.createEl("button", {
      cls: "current-note-ai-model-refresh clickable-icon",
      text: this.modelLoading ? "…" : "↻",
      attr: {
        "aria-label": "Refresh AI models",
        title: "Refresh configured provider model lists (does not send note content)",
      },
    });
    refreshModels.disabled = this.busy || this.modelLoading;
    refreshModels.addEventListener("click", () => void this.refreshModels());

    const selectedProfile = this.plugin.settings.providerProfiles.find((profile) => profile.id === this.plugin.settings.selectedProfileModel?.profileId);
    if (selectedProfile?.providerId === "chatgpt") {
      const planLink = modelBar.createEl("a", { text: "Using ChatGPT plan · Manage usage" });
      planLink.href = "https://chatgpt.com/settings/usage";
      planLink.setAttr("target", "_blank");
      planLink.setAttr("rel", "noopener noreferrer");
      const selectedModel = selectedProfile.catalog.models.find((model) => model.id === this.plugin.settings.selectedProfileModel?.modelId);
      if (selectedModel?.catalogSource === "manual") {
        modelBar.createSpan({ cls: "current-note-ai-model-access-hint", text: "Not in the account catalog. Access is checked on Send; no model fallback." });
      }
      const reasoning = modelBar.createEl("select", { cls: "current-note-ai-option-select", attr: { "aria-label": "ChatGPT reasoning effort", title: "ChatGPT reasoning effort" } });
      reasoning.createEl("option", { text: "Reasoning · Auto", value: "auto" });
      const effortOptions = chatGptEffortChoices(selectedModel);
      for (const effort of effortOptions) reasoning.createEl("option", { text: `Reasoning · ${effort}`, value: effort });
      const savedEffort = selectedProfile.chatgptReasoningEffort ?? "auto";
      if (savedEffort !== "auto" && !effortOptions.includes(savedEffort)) {
        const unavailableEffort = reasoning.createEl("option", { text: `Reasoning · ${savedEffort} (unavailable)`, value: savedEffort });
        unavailableEffort.disabled = true;
      }
      reasoning.value = savedEffort;
      reasoning.disabled = this.busy || this.modelLoading;
      reasoning.addEventListener("change", () => {
        const effort = reasoning.value as ChatGptReasoningEffort;
        void this.plugin.updateChatGptOptions(selectedProfile.id, {
          reasoningEffort: effort,
          speed: selectedProfile.chatgptSpeed ?? "standard",
        }).catch((error) => new Notice(error instanceof Error ? error.message : "Could not update ChatGPT reasoning."));
      });
      const speed = modelBar.createEl("select", { cls: "current-note-ai-option-select", attr: { "aria-label": "ChatGPT speed", title: "ChatGPT speed (fast may use more quota)" } });
      speed.createEl("option", { text: "Speed · Standard", value: "standard" });
      speed.createEl("option", { text: "Speed · Fast (uses more quota)", value: "fast" });
      const ultrafast = speed.createEl("option", { text: "Ultrafast · not eligible on Plus", value: "ultrafast" });
      ultrafast.disabled = true;
      speed.value = selectedProfile.chatgptSpeed ?? "standard";
      speed.disabled = this.busy || this.modelLoading;
      speed.addEventListener("change", () => {
        const selectedSpeed = speed.value === "fast" ? "fast" : "standard";
        void this.plugin.updateChatGptOptions(selectedProfile.id, {
          reasoningEffort: selectedProfile.chatgptReasoningEffort ?? "auto",
          speed: selectedSpeed as ChatGptServiceTier,
        }).catch((error) => new Notice(error instanceof Error ? error.message : "Could not update ChatGPT speed."));
      });
    }

    const actions = header.createDiv({ cls: "current-note-ai-header-actions" });
    if (this.busy) {
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.cancelLogicalRequest());
    }
    if (this.lastApplied) {
      const revert = actions.createEl("button", { text: "Revert AI edit" });
      this.revertButton = revert;
      revert.disabled = !this.canRevertAppliedChange();
      revert.addEventListener("click", () => void this.revertLastApplied());
    }
    if (this.plugin.hasPendingSave) {
      const retrySave = actions.createEl("button", {
        text: "Retry save",
        attr: { title: "Retry saving Current Note AI settings and conversation history" },
      });
      retrySave.disabled = this.busy;
      retrySave.addEventListener("click", () => void this.retryPendingSave());
    }
    const clear = actions.createEl("button", {
      text: "Clear",
      attr: { title: "Start a new conversation; saved history is retained" },
    });
    clear.disabled = this.busy;
    clear.addEventListener("click", () => this.clearConversation());
  }

  private renderHistoryPanel(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "current-note-ai-history-panel" });
    const history = this.plugin.settings.conversationHistory;
    if (history.length === 0) {
      panel.createDiv({
        cls: "current-note-ai-history-empty",
        text: "No saved conversations yet. The first message names and saves a conversation automatically.",
      });
      return;
    }

    const historyActions = panel.createDiv({ cls: "current-note-ai-history-actions" });
    const clearAll = historyActions.createEl("button", { text: "Delete all history" });
    clearAll.disabled = this.busy;
    clearAll.addEventListener("click", () => void this.deleteAllHistory());

    const list = panel.createDiv({ cls: "current-note-ai-history-list" });
    for (const conversation of history) {
      const itemRow = list.createDiv({ cls: "current-note-ai-history-row" });
      const item = itemRow.createEl("button", {
        cls: conversation.id === this.activeConversationId
          ? "current-note-ai-history-item is-active"
          : "current-note-ai-history-item",
        attr: {
          title: `Open ${conversation.title}`,
        },
      });
      item.createDiv({
        cls: "current-note-ai-history-title",
        text: conversation.title,
      });
      item.createDiv({
        cls: "current-note-ai-history-meta",
        text: `${conversation.noteName || "Unknown note"} · ${this.formatHistoryTime(conversation.updatedAt)}`,
      });
      item.addEventListener("click", () => this.loadConversation(conversation));
      const remove = itemRow.createEl("button", {
        cls: "current-note-ai-history-delete",
        text: "×",
        attr: {
          "aria-label": `Delete conversation ${conversation.title}`,
          title: "Delete this saved conversation",
        },
      });
      remove.disabled = this.busy;
      remove.addEventListener("click", () => void this.deleteHistoryConversation(conversation));
    }
  }

  private loadConversation(conversation: SavedConversation): void {
    this.requestGeneration += 1;
    this.busy = false;
    this.messages = conversation.messages.map((message) => ({ ...message }));
    this.messageHtmlCache.clear();
    this.pendingProposal = null;
    this.editRetry = null;
    this.lastApplied = null;
    this.draft = "";
    this.errorMessage = "";
    this.historyOpen = false;
    this.activeConversationId = conversation.id;
    this.activeConversationTitle = conversation.title;
    this.activeConversationCreatedAt = conversation.createdAt;
    this.activeConversationNotePath = conversation.notePath;
    this.activeConversationNoteName = conversation.noteName;
    this.render();
  }

  private formatHistoryTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  private async chooseModel(model: ProfileModelRef): Promise<void> {
    try {
      await this.plugin.selectModel(model);
      this.errorMessage = "";
    } catch (error) {
      this.errorMessage = this.describeError(error);
    }
    this.render();
  }

  private sameProfileModel(left: ProfileModelRef, right: ProfileModelRef | null): boolean {
    return sameProfileModel(left, right);
  }

  private async refreshModels(): Promise<void> {
    if (this.busy || this.modelLoading) return;
    this.modelLoading = true;
    this.errorMessage = "";
    this.render();
    try {
      const summary = await this.plugin.refreshModels();
      const message = summary.results.map((result) => {
        if (result.status === "updated") {
          const excluded = result.excludedCount > 0
            ? `; ${result.excludedCount} unsupported excluded`
            : "";
          return `${result.displayName}: ${result.models.length} updated${excluded}`;
        }
        if (result.status === "skipped") return `${result.displayName}: not configured`;
        return `${result.displayName}: refresh failed, cached list kept`;
      }).join(" · ");
      new Notice(message);
      const failures = summary.results.filter((result) => result.status === "failed");
      if (failures.length > 0) {
        this.errorMessage = failures
          .map((result) => `${result.displayName}: ${result.error ?? "model refresh failed"}`)
          .join("\n");
      }
    } catch (error) {
      this.errorMessage = this.describeError(error);
    } finally {
      this.modelLoading = false;
      this.render();
    }
  }

  private renderContextBar(container: HTMLElement): void {
    const row = container.createDiv({ cls: "current-note-ai-context" });
    const current = this.plugin.documentGate.getCurrent();
    this.observedCurrentLeaf = current?.leaf ?? null;
    this.observedCurrentFile = current?.file ?? null;

    if (!this.bound) {
      row.createDiv({
        cls: "current-note-ai-context-details",
        text: "No Markdown note is bound.",
      });
    } else {
      const details = row.createDiv({ cls: "current-note-ai-context-details" });
      details.createDiv({
        cls: "current-note-ai-context-label",
        text: "FULL MARKDOWN CONTEXT",
      });
      details.createDiv({
        cls: "current-note-ai-context-file",
        text: this.bound.file.basename,
      });
    }

    const differs = !current
      || !this.bound
      || current.leaf !== this.bound.leaf
      || current.file !== this.bound.file
      || current.filePath !== this.bound.filePath;
    if (differs) {
      const button = row.createEl("button", {
        text: current ? "Use current note" : "Open a Markdown note",
        cls: "mod-cta current-note-ai-context-action",
      });
      button.disabled = !current || this.busy || this.modelLoading;
      button.addEventListener("click", () => this.bindToCurrent());
    } else {
      row.createDiv({ cls: "current-note-ai-context-ready", text: "Bound" });
    }
  }

  private renderMessage(container: HTMLElement, message: ConversationMessage): void {
    const row = container.createDiv({
      cls: `current-note-ai-message-row is-${message.role}`,
    });
    const group = row.createDiv({ cls: "current-note-ai-message-group" });
    if (message.role === "assistant") this.renderMessageProvenance(group, message);
    const bubble = group.createDiv({ cls: "current-note-ai-bubble" });
    bubble.addClass("current-note-ai-markdown", "markdown-rendered");
    const cached = this.messageHtmlCache.get(message.id);
    const html = cached?.source === message.content
      ? cached.html
      : renderAssistantMarkdown(message.content);
    if (!cached || cached.source !== message.content) {
      this.messageHtmlCache.set(message.id, { source: message.content, html });
    }
    bubble.innerHTML = html;
    if (message.role === "assistant") this.renderMessageMetadata(group, message);
    const footer = group.createDiv({ cls: "current-note-ai-message-footer" });
    if (message.role === "assistant") {
      const timestamp = formatMessageDateTime(message.createdAt);
      if (timestamp) footer.createEl("time", {
        cls: "current-note-ai-message-time",
        text: timestamp.text,
        attr: {
          datetime: timestamp.dateTime,
          title: `Answer received · ${timestamp.timeZone} · ${timestamp.dateTime}`,
          "aria-label": `Date & Time · ${timestamp.text} · ${timestamp.timeZone}`,
        },
      });
    }
    const actions = footer.createDiv({ cls: "current-note-ai-message-actions" });
    const copy = actions.createEl("button", {
      cls: "current-note-ai-copy-button",
      text: "Copy",
      attr: { title: "Copy original message (Markdown / LaTeX)", "aria-label": "Copy original message" },
    });
    copy.addEventListener("click", () => {
      const clipboard = this.contentEl.win.navigator?.clipboard;
      void copyMessageText(message.content, clipboard)
        .then(() => new Notice("Message copied."))
        .catch((error: Error) => new Notice(error.message));
    });
  }

  private renderMessageProvenance(container: HTMLElement, message: ConversationMessage): void {
    const header = container.createDiv({
      cls: "current-note-ai-message-provenance",
      attr: { role: "group", "aria-label": message.origin === "local" ? "Local action" : "Model and Reasoning" },
    });
    if (message.origin === "local") {
      header.createSpan({ cls: "current-note-ai-message-model", text: "Current Note AI · Local action" });
      return;
    }
    const model = message.modelId || message.target?.modelId;
    header.createSpan({
      cls: "current-note-ai-message-model",
      text: `Model · ${model || "Not recorded"}`,
      attr: { title: model ? `Model selected for this answer: ${model}` : "This older message did not record its model." },
    });
    header.createSpan({
      cls: "current-note-ai-message-reasoning",
      text: `Reasoning · ${reasoningLabel(message.reasoning)}`,
      attr: {
        title: message.reasoning === undefined ? "This older message did not record its reasoning setting."
          : message.reasoning === "auto" ? "Server default requested; actual reasoning effort was not reported."
            : "Requested reasoning setting at generation time; not a display of hidden reasoning.",
      },
    });
  }

  private renderMessageMetadata(container: HTMLElement, message: ConversationMessage): void {
    if (message.generationState !== "incomplete" && !message.actualServiceTier) return;

    const metadata = container.createDiv({ cls: "current-note-ai-message-metadata", attr: { role: "group", "aria-label": "Generation status" } });
    if (message.generationState === "incomplete") {
      const reason = message.finishReason === "length"
        ? "Incomplete · output limit reached"
        : `Incomplete · finish reason: ${message.finishReason ?? "unknown"}`;
      metadata.createSpan({ cls: "current-note-ai-incomplete-label", text: reason });
    }
    if (message.actualServiceTier) {
      metadata.createSpan({ cls: "current-note-ai-service-tier", text: `Server speed · ${chatGptSpeedLabel(message.actualServiceTier)}` });
    }

    const completionTokens = message.usage?.completionTokens;
    if (message.generationState === "incomplete" && completionTokens !== undefined) {
      metadata.createSpan({ text: `${completionTokens.toLocaleString()} generated tokens` });
    }

    if (!this.canContinueMessage(message)) return;
    const continueButton = metadata.createEl("button", {
      cls: "current-note-ai-continue-button",
      text: "Continue",
      attr: {
        title: `Send a new AI request with up to ${this.plugin.settings.maxTokens.toLocaleString()} additional tokens`,
      },
    });
    continueButton.addEventListener("click", () => void this.continueDiscussion(message));
  }

  private canContinueMessage(message: ConversationMessage): boolean {
    return !this.busy
      && !this.modelLoading
      && !this.hasHistoryBindingMismatch()
      && this.messages.at(-1)?.id === message.id
      && message.requestKind === "discussion"
      && message.target !== undefined
      && message.finishReason === "length"
      && typeof message.noteHash === "string"
      && (message.continuationCount ?? 0) < MAX_DISCUSSION_CONTINUATIONS;
  }

  private renderTypingBubble(container: HTMLElement): void {
    const row = container.createDiv({ cls: "current-note-ai-message-row is-assistant" });
    const bubble = row.createDiv({
      cls: "current-note-ai-bubble is-typing",
      attr: { role: "status", "aria-label": "AI provider is responding" },
    });
    bubble.createSpan();
    bubble.createSpan();
    bubble.createSpan();
  }

  private renderEditRetry(container: HTMLElement, retry: EditRetryState): void {
    const card = container.createDiv({ cls: "current-note-ai-recovery" });
    card.createEl("strong", { text: "Edit proposal incomplete" });
    card.createEl("p", { text: retry.reason });
    if (retry.nextMaxTokens !== null && !retry.retryAttempted) {
      card.createDiv({
        cls: "current-note-ai-recovery-cost",
        text: "Retrying starts a new paid API request, may take longer, and may produce a different proposal.",
      });
    }
    const actions = card.createDiv({ cls: "current-note-ai-recovery-actions" });

    const revise = actions.createEl("button", { text: "Revise request" });
    revise.disabled = this.busy;
    revise.addEventListener("click", () => {
      this.draft = retry.request;
      this.editRetry = null;
      this.render();
    });

    if (retry.nextMaxTokens !== null && !retry.retryAttempted) {
      const retryButton = actions.createEl("button", {
        cls: "mod-cta",
        text: `Retry with ${retry.nextMaxTokens.toLocaleString()}`,
        attr: {
          title: "Starts a new paid API request. The regenerated proposal may differ.",
        },
      });
      retryButton.disabled = this.busy;
      retryButton.addEventListener("click", () => void this.retryEditProposal(retry));
    }
  }

  private renderProposal(container: HTMLElement, proposal: PendingProposal): void {
    const card = container.createDiv({ cls: "current-note-ai-proposal" });
    const stale = this.isProposalStale(proposal);
    const heading = card.createDiv({ cls: "current-note-ai-proposal-heading" });
    const headingText = heading.createDiv();
    headingText.createEl("strong", { text: "Edit proposal" });
    headingText.createDiv({
      cls: "current-note-ai-proposal-stats",
      text: `${proposal.candidate.operations.length} operations · ${Math.round(proposal.candidate.changeRatio * 100)}% change budget`,
    });
    this.proposalStatusEl = heading.createDiv({
      cls: stale ? "current-note-ai-status is-stale" : "current-note-ai-status",
      text: stale ? "Stale" : "Ready",
    });
    card.createEl("p", { text: proposal.candidate.summary });

    const selectionActions = card.createDiv({ cls: "current-note-ai-selection-actions" });
    const selectAll = selectionActions.createEl("button", { text: "All" });
    selectAll.addEventListener("click", () => {
      proposal.selectedIds = new Set(proposal.candidate.operations.map((operation) => operation.id));
      this.render();
    });
    const selectNone = selectionActions.createEl("button", { text: "None" });
    selectNone.addEventListener("click", () => {
      proposal.selectedIds.clear();
      this.render();
    });

    for (const operation of proposal.candidate.operations) {
      const item = card.createEl("details", { cls: "current-note-ai-operation" });
      item.open = true;
      const summary = item.createEl("summary");
      const checkbox = summary.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": `Select edit: ${operation.reason}` },
      });
      checkbox.checked = proposal.selectedIds.has(operation.id);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) proposal.selectedIds.add(operation.id);
        else proposal.selectedIds.delete(operation.id);
        this.render();
      });
      summary.createSpan({ text: operation.reason });

      const diff = item.createDiv({ cls: "current-note-ai-diff" });
      const removed = diff.createDiv({ cls: "current-note-ai-diff-block is-removed" });
      removed.createDiv({ cls: "current-note-ai-diff-label", text: "REMOVE" });
      removed.createEl("pre", { text: operation.oldText });
      const added = diff.createDiv({ cls: "current-note-ai-diff-block is-added" });
      added.createDiv({ cls: "current-note-ai-diff-label", text: "ADD" });
      added.createEl("pre", { text: operation.newText || "(delete without replacement)" });
    }

    const actions = card.createDiv({ cls: "current-note-ai-proposal-actions" });
    const discard = actions.createEl("button", { text: "Discard" });
    discard.addEventListener("click", () => {
      this.pendingProposal = null;
      this.render();
    });
    const regenerate = actions.createEl("button", { text: "Regenerate" });
    regenerate.disabled = this.busy;
    regenerate.addEventListener("click", () => {
      this.draft = proposal.request;
      this.pendingProposal = null;
      this.render();
    });
    const apply = actions.createEl("button", { text: "Apply selected", cls: "mod-cta" });
    this.proposalApplyButton = apply;
    apply.disabled = stale || proposal.selectedIds.size === 0 || this.busy;
    apply.addEventListener("click", () => void this.applyProposal(proposal));
  }

  private renderComposer(container: HTMLElement): void {
    const composer = container.createDiv({ cls: "current-note-ai-composer" });
    const historyMismatch = this.hasHistoryBindingMismatch();
    const textarea = composer.createEl("textarea", {
      attr: {
        placeholder: historyMismatch
          ? `Open ${this.activeConversationNoteName || "the original note"} to continue…`
          : "Ask about the current note…",
        rows: "3",
      },
    });
    textarea.value = this.draft;
    textarea.disabled = this.busy || this.modelLoading || historyMismatch;
    textarea.addEventListener("input", () => {
      this.draft = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (shouldSubmitComposer(event)) {
        event.preventDefault();
        event.stopPropagation();
        void this.sendDiscussion();
      }
    });

    const actions = composer.createDiv({ cls: "current-note-ai-composer-actions" });
    const selectedProfile = this.plugin.settings.providerProfiles.find((profile) => profile.id === this.plugin.settings.selectedProfileModel?.profileId);
    if (selectedProfile?.providerId === "chatgpt") {
      actions.createSpan({ cls: "current-note-ai-composer-hint", text: "Using ChatGPT plan" });
    }
    actions.createDiv({
      cls: "current-note-ai-composer-hint",
      text: "↵ newline · ⇧↵ send",
    });
    const buttons = actions.createDiv({ cls: "current-note-ai-composer-buttons" });
    const propose = buttons.createEl("button", { text: "Propose changes" });
    propose.disabled = this.busy || this.modelLoading || historyMismatch;
    propose.addEventListener("click", () => void this.requestEditProposal());
    const send = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
    send.disabled = this.busy || this.modelLoading || historyMismatch;
    send.addEventListener("click", () => void this.sendDiscussion());
  }

  private bindToCurrent(): void {
    const current = this.plugin.documentGate.getCurrent();
    if (!current) {
      this.errorMessage = "Open a Markdown note in the main editor before binding the sidebar.";
      this.render();
      return;
    }
    this.requestGeneration += 1;
    this.bound = current;
    const preservesLoadedHistory = this.activeConversationId !== null
      && this.activeConversationNotePath === current.filePath;
    if (!preservesLoadedHistory) this.resetConversationState();
    this.errorMessage = "";
    this.render();
  }

  private clearConversation(): void {
    this.requestGeneration += 1;
    this.busy = false;
    this.messages = [];
    this.messageHtmlCache.clear();
    this.pendingProposal = null;
    this.editRetry = null;
    this.lastApplied = null;
    this.errorMessage = "";
    this.draft = "";
    this.historyOpen = false;
    this.resetConversationMetadata();
    this.render();
  }

  private cancelLogicalRequest(): void {
    this.requestGeneration += 1;
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.busy = false;
    this.errorMessage = `The response will be ignored. ${this.activeRequestProviderName} may already be processing the request remotely.`;
    this.render();
  }

  private async ensureConsent(
    context: ProviderRequestContext,
    history: readonly ConversationMessage[],
  ): Promise<boolean> {
    const includesCrossProviderHistory = history.some((message) => {
      if (message.role !== "assistant") return false;
      if (message.target === undefined) return true;
      return message.target.profileId !== context.profile.id;
    });
    const requiredRevision = includesCrossProviderHistory ? 2 : 1;
    const grant = this.plugin.settings.profileConsents[context.profile.id];
    if (grant
      && grant.profileRevision === context.profile.revision
      && grant.providerId === context.profile.providerId
      && grant.disclosureRevision >= requiredRevision) return true;

    const accepted = await new FullNoteConsentModal(
      this.app,
      context.profile.label,
      context.displayName,
      context.destination,
      includesCrossProviderHistory,
      context.profile.providerId === "kimi-code",
      context.profile.providerId === "chatgpt",
    ).request();
    if (!accepted) return false;
    this.plugin.settings.profileConsents[context.profile.id] = {
      disclosureRevision: requiredRevision,
      acceptedAt: Date.now(),
      profileRevision: context.profile.revision,
      providerId: context.profile.providerId,
    };
    await this.plugin.saveSettings();
    return true;
  }

  private captureCurrentSnapshot(): DocumentSnapshot {
    if (!this.bound) {
      throw new CurrentDocumentError("Bind the sidebar to a Markdown note first.");
    }
    const snapshot = this.plugin.documentGate.capture(this.bound);
    if (snapshot.text.length > MAX_DOCUMENT_CHARACTERS) {
      throw new CurrentDocumentError(
        `This note contains ${snapshot.text.length.toLocaleString()} characters, above the MVP safety limit. It was not sent or truncated.`,
      );
    }
    return snapshot;
  }

  private assertRequestBudget(
    messages: readonly ProviderMessage[],
    maxOutputTokens: number,
    context: ProviderRequestContext,
  ): void {
    const budget = evaluateRequestBudget(messages, maxOutputTokens, {
      contextWindowTokens: context.contextWindowTokens,
    });
    if (budget.fits) return;
    throw new CurrentDocumentError(
      `${context.displayName} model ${context.model.modelId} needs an estimated ${budget.requiredTokens.toLocaleString()} tokens including safety margin, above the conservative ${budget.contextWindowTokens.toLocaleString()}-token context limit. Reduce the current note or output budget before retrying. Nothing was sent.`,
    );
  }

  private completionOptions(
    context: ProviderRequestContext,
    maxTokens: number,
    responseFormat: CompletionOptions["responseFormat"],
  ): CompletionOptions {
    const effort = context.profile.chatgptReasoningEffort;
    if (context.profile.providerId === "chatgpt" && effort && effort !== "auto"
      && !chatGptEffortChoices(context.profile.catalog.models.find((model) => model.id === context.model.modelId)).includes(effort)) {
      throw new CurrentDocumentError("The selected reasoning effort is unavailable for this GPT model. Choose Auto or a supported effort in the header. Nothing was sent.");
    }
    return {
      model: context.model.modelId,
      maxTokens,
      responseFormat,
      ...(context.profile.providerId === "deepseek"
        ? { temperature: this.plugin.settings.temperature }
        : {}),
      ...(context.profile.providerId === "chatgpt" && context.profile.chatgptReasoningEffort && context.profile.chatgptReasoningEffort !== "auto"
        ? { reasoningEffort: context.profile.chatgptReasoningEffort }
        : {}),
      ...(context.profile.providerId === "chatgpt"
        ? { serviceTier: context.profile.chatgptSpeed === "fast" ? "fast" as const : "default" as const }
        : {}),
    };
  }

  private async completeRequest(context: ProviderRequestContext, request: CompletionRequest): Promise<CompletionResponse & { generationMetadata: Readonly<GenerationMetadata> }> {
    const controller = new AbortController();
    const generationMetadata = captureGenerationMetadata(context.model.providerId, request.options);
    this.requestAbort = controller;
    this.activeRequestProfileId = context.profile.id;
    try {
      const response = await context.adapter.complete(this.plugin.getApiKey(context.profile.id), request, controller.signal);
      return { ...response, generationMetadata };
    } finally {
      if (this.requestAbort === controller) {
        this.requestAbort = null;
        this.activeRequestProfileId = null;
      }
    }
  }

  private hasHistoryBindingMismatch(): boolean {
    return this.activeConversationId !== null
      && this.activeConversationNotePath.length > 0
      && this.bound?.filePath !== this.activeConversationNotePath;
  }

  private resetConversationState(): void {
    this.messages = [];
    this.messageHtmlCache.clear();
    this.pendingProposal = null;
    this.editRetry = null;
    this.lastApplied = null;
    this.draft = "";
    this.resetConversationMetadata();
  }

  private resetConversationMetadata(): void {
    this.activeConversationId = null;
    this.activeConversationTitle = "";
    this.activeConversationCreatedAt = 0;
    this.activeConversationNotePath = "";
    this.activeConversationNoteName = "";
  }

  private refreshLiveEditState(): void {
    if (this.pendingProposal && this.proposalStatusEl && this.proposalApplyButton) {
      const stale = this.isProposalStale(this.pendingProposal);
      this.proposalStatusEl.setText(stale ? "Stale" : "Ready");
      this.proposalStatusEl.classList.toggle("is-stale", stale);
      this.proposalApplyButton.disabled = stale
        || this.pendingProposal.selectedIds.size === 0
        || this.busy;
    }
    if (this.revertButton) {
      this.revertButton.disabled = !this.canRevertAppliedChange();
    }
  }

  private canRevertAppliedChange(): boolean {
    if (!this.lastApplied) return false;
    try {
      const view = this.plugin.documentGate.assertCurrent(this.lastApplied.binding);
      return view.editor.getValue() === this.lastApplied.afterText;
    } catch {
      return false;
    }
  }

  private async retryPendingSave(): Promise<void> {
    try {
      await this.plugin.retryPendingSave();
      this.errorMessage = "";
      new Notice("Current Note AI data saved.");
    } catch (error) {
      this.errorMessage = `Current Note AI data is still not saved: ${this.describeError(error)}`;
    }
    this.render();
  }

  private async deleteHistoryConversation(conversation: SavedConversation): Promise<void> {
    const confirmed = this.contentEl.win.confirm(
      `Delete the saved conversation “${conversation.title}”? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await this.plugin.deleteConversation(conversation.id);
      if (this.activeConversationId === conversation.id) this.clearConversation();
      else this.render();
      new Notice("Saved conversation deleted.");
    } catch (error) {
      this.errorMessage = this.describeError(error);
      this.render();
    }
  }

  private async deleteAllHistory(): Promise<void> {
    const confirmed = this.contentEl.win.confirm(
      "Delete all saved Current Note AI conversations? This cannot be undone.",
    );
    if (!confirmed) return;
    try {
      await this.plugin.clearConversationHistory();
      this.clearConversation();
      new Notice("All Current Note AI conversation history was deleted.");
    } catch (error) {
      this.errorMessage = this.describeError(error);
      this.render();
    }
  }

  private async persistConversation(snapshot?: DocumentSnapshot): Promise<void> {
    if (this.messages.length === 0) return;

    const now = Date.now();
    if (!this.activeConversationId) {
      const firstUserMessage = this.messages.find((message) => message.role === "user");
      this.activeConversationId = `conversation-${now}-${Math.random().toString(36).slice(2, 9)}`;
      this.activeConversationTitle = createConversationTitle(
        firstUserMessage?.content ?? "",
        this.bound?.file.basename ?? "",
      );
      this.activeConversationCreatedAt = now;
      this.activeConversationNotePath = snapshot?.filePath ?? this.bound?.filePath ?? "";
      this.activeConversationNoteName = this.bound?.file.basename ?? "";
    }

    await this.plugin.upsertConversation({
      id: this.activeConversationId,
      title: this.activeConversationTitle,
      notePath: this.activeConversationNotePath,
      noteName: this.activeConversationNoteName,
      messages: this.messages.map((message) => ({ ...message })),
      createdAt: this.activeConversationCreatedAt,
      updatedAt: now,
    });
  }

  private async sendDiscussion(): Promise<void> {
    const request = this.draft.trim();
    if (!request || this.busy || this.modelLoading) return;
    let generation: number | null = null;

    try {
      const history = this.messages.slice();
      const context = this.plugin.resolveRequestContext();
      this.activeRequestProviderName = context.displayName;
      if (!await this.ensureConsent(context, history)) return;
      const snapshot = this.captureCurrentSnapshot();
      this.messages.push(this.newMessage("user", request));
      this.draft = "";
      this.errorMessage = "";
      this.busy = true;
      generation = ++this.requestGeneration;
      await this.persistConversation(snapshot);
      this.render();

      const providerMessages = buildDiscussionMessages(
        snapshot.text,
        history,
        request,
        this.plugin.settings.maxTokens,
      );
      this.assertRequestBudget(providerMessages, this.plugin.settings.maxTokens, context);
      if (generation !== this.requestGeneration) return;
      const response = await this.completeRequest(
        context,
        {
        messages: providerMessages,
          options: this.completionOptions(context, this.plugin.settings.maxTokens, "text"),
        },
      );
      if (generation !== this.requestGeneration) return;

      this.messages.push(this.newMessage("assistant", response.content, {
        ...response.generationMetadata,
        requestKind: "discussion",
        finishReason: response.finishReason,
        actualServiceTier: response.actualServiceTier,
        generationState: response.finishReason === "stop" ? "complete" : "incomplete",
        usage: response.usage,
        noteHash: snapshot.hash,
        continuationCount: 0,
        target: context.target,
      }));
      await this.persistConversation(snapshot);
    } catch (error) {
      if (generation === null || generation === this.requestGeneration) {
        this.errorMessage = this.describeError(error);
      }
    } finally {
      if (generation === null || generation === this.requestGeneration) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async continueDiscussion(incompleteMessage: ConversationMessage): Promise<void> {
    if (!this.canContinueMessage(incompleteMessage)) return;
    let generation: number | null = null;

    try {
      const history = this.messages.slice();
      if (!incompleteMessage.target) {
        throw new CurrentDocumentError(
          "This legacy response has no frozen provider target and cannot be continued safely. Ask the question again.",
        );
      }
      const context = this.plugin.resolveRequestContext(incompleteMessage.target);
      this.activeRequestProviderName = context.displayName;
      if (!await this.ensureConsent(context, history)) return;
      const snapshot = this.captureCurrentSnapshot();
      if (incompleteMessage.noteHash && incompleteMessage.noteHash !== snapshot.hash) {
        throw new CurrentDocumentError(
          `The note changed after this incomplete response. Ask again so ${context.displayName} uses the current text.`,
        );
      }

      this.errorMessage = "";
      this.busy = true;
      generation = ++this.requestGeneration;
      this.render();

      const providerMessages = buildDiscussionContinuationMessages(
        snapshot.text,
        history,
        this.plugin.settings.maxTokens,
      );
      this.assertRequestBudget(providerMessages, this.plugin.settings.maxTokens, context);
      if (generation !== this.requestGeneration) return;
      const response = await this.completeRequest(
        context,
        {
          messages: providerMessages,
          options: this.completionOptions(context, this.plugin.settings.maxTokens, "text"),
        },
      );
      if (generation !== this.requestGeneration) return;

      const trimmedContent = trimExactContinuationOverlap(
        incompleteMessage.content,
        response.content,
      );
      if (!trimmedContent.trim()) {
        throw new ProviderRequestError(
          context.model.providerId,
          "complete",
          "empty-continuation",
          `${context.displayName} repeated the previous ending without adding new content. You can try Continue again.`,
        );
      }
      this.messages.push(this.newMessage("user", "Continue"));
      this.messages.push(this.newMessage("assistant", trimmedContent, {
        ...response.generationMetadata,
        requestKind: "discussion",
        finishReason: response.finishReason,
        actualServiceTier: response.actualServiceTier,
        generationState: response.finishReason === "stop" ? "complete" : "incomplete",
        usage: response.usage,
        noteHash: snapshot.hash,
        continuationCount: (incompleteMessage.continuationCount ?? 0) + 1,
        target: context.target,
      }));
      await this.persistConversation(snapshot);
    } catch (error) {
      if (generation === null || generation === this.requestGeneration) {
        this.errorMessage = this.describeError(error);
      }
    } finally {
      if (generation === null || generation === this.requestGeneration) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async requestEditProposal(): Promise<void> {
    const request = this.draft.trim();
    if (!request || this.busy || this.modelLoading) return;
    let generation: number | null = null;

    try {
      const history = this.messages.slice();
      const context = this.plugin.resolveRequestContext();
      this.activeRequestProviderName = context.displayName;
      if (!await this.ensureConsent(context, history)) return;
      const snapshot = this.captureCurrentSnapshot();
      this.messages.push(this.newMessage("user", request));
      this.draft = "";
      this.errorMessage = "";
      this.pendingProposal = null;
      this.editRetry = null;
      this.busy = true;
      generation = ++this.requestGeneration;
      await this.persistConversation(snapshot);
      this.render();

      const providerMessages = buildEditMessages(
        snapshot.text,
        history,
        request,
        this.plugin.settings.maxTokens,
      );
      this.assertRequestBudget(providerMessages, this.plugin.settings.maxTokens, context);
      if (generation !== this.requestGeneration) return;
      const response = await this.completeRequest(
        context,
        {
          messages: providerMessages,
          options: this.completionOptions(context, this.plugin.settings.maxTokens, "json"),
        },
      );
      if (generation !== this.requestGeneration) return;
      if (response.finishReason !== "stop") {
        this.editRetry = this.createEditRetryState(
          snapshot,
          history,
          request,
          this.plugin.settings.maxTokens,
          false,
          `${context.displayName} ended with finish_reason=${response.finishReason}. The partial JSON was discarded and cannot be applied.`,
          context.target,
        );
        return;
      }

      let candidate: EditProposalCandidate;
      try {
        candidate = validateEditProposal(response.content, snapshot.text, {
          maxOperations: this.plugin.settings.maxOperations,
          maxChangeRatio: this.plugin.settings.maxChangeRatio,
        });
      } catch (error) {
        if (error instanceof EditProposalError && error.code === "needs-segmentation") {
          this.editRetry = this.createEditRetryState(
            snapshot,
            history,
            request,
            this.plugin.settings.maxTokens,
            false,
            error.message,
            context.target,
          );
          return;
        }
        throw error;
      }
      this.pendingProposal = {
        candidate,
        snapshot,
        selectedIds: new Set(candidate.operations.map((operation) => operation.id)),
        request,
      };
      this.messages.push(this.newMessage("assistant", candidate.summary, {
        ...response.generationMetadata,
        requestKind: "edit",
        finishReason: response.finishReason,
        actualServiceTier: response.actualServiceTier,
        generationState: "complete",
        usage: response.usage,
        noteHash: snapshot.hash,
        target: context.target,
      }));
      await this.persistConversation(snapshot);
    } catch (error) {
      if (generation === null || generation === this.requestGeneration) {
        this.errorMessage = this.describeError(error);
      }
    } finally {
      if (generation === null || generation === this.requestGeneration) {
        this.busy = false;
        this.render();
      }
    }
  }

  private createEditRetryState(
    snapshot: DocumentSnapshot,
    history: ConversationMessage[],
    request: string,
    maxTokensUsed: number,
    retryAttempted: boolean,
    reason: string,
    target: FrozenRequestTarget,
  ): EditRetryState {
    return {
      snapshot,
      history: history.map((message) => ({ ...message })),
      request,
      maxTokensUsed,
      nextMaxTokens: retryAttempted ? null : nextEditRetryBudget(maxTokensUsed),
      retryAttempted,
      reason,
      target: { ...target },
    };
  }

  private async retryEditProposal(retry: EditRetryState): Promise<void> {
    if (this.busy || this.modelLoading || retry.retryAttempted || retry.nextMaxTokens === null) return;
    let generation: number | null = null;
    const retryBudget = retry.nextMaxTokens;

    try {
      const context = this.plugin.resolveRequestContext(retry.target);
      this.activeRequestProviderName = context.displayName;
      if (!await this.ensureConsent(context, this.messages)) return;
      const currentSnapshot = this.captureCurrentSnapshot();
      if (currentSnapshot.hash !== retry.snapshot.hash) {
        throw new CurrentDocumentError(
          "The note changed after the incomplete edit response. Revise and resend the request against the current note.",
        );
      }

      this.errorMessage = "";
      this.pendingProposal = null;
      this.editRetry = null;
      this.busy = true;
      generation = ++this.requestGeneration;
      this.render();

      const providerMessages = buildEditMessages(
        retry.snapshot.text,
        retry.history,
        retry.request,
        retryBudget,
      );
      this.assertRequestBudget(providerMessages, retryBudget, context);
      if (generation !== this.requestGeneration) return;
      const response = await this.completeRequest(
        context,
        {
          messages: providerMessages,
          options: this.completionOptions(context, retryBudget, "json"),
        },
      );
      if (generation !== this.requestGeneration) return;

      if (response.finishReason !== "stop") {
        this.editRetry = this.createEditRetryState(
          retry.snapshot,
          retry.history,
          retry.request,
          retryBudget,
          true,
          `${context.displayName}'s ${retryBudget.toLocaleString()}-token retry also ended with finish_reason=${response.finishReason}. Narrow the edit request before trying again.`,
          context.target,
        );
        return;
      }

      let candidate: EditProposalCandidate;
      try {
        candidate = validateEditProposal(response.content, retry.snapshot.text, {
          maxOperations: this.plugin.settings.maxOperations,
          maxChangeRatio: this.plugin.settings.maxChangeRatio,
        });
      } catch (error) {
        if (error instanceof EditProposalError && error.code === "needs-segmentation") {
          this.editRetry = this.createEditRetryState(
            retry.snapshot,
            retry.history,
            retry.request,
            retryBudget,
            true,
            `${error.message} Narrow the edit request before trying again.`,
            context.target,
          );
          return;
        }
        throw error;
      }

      this.pendingProposal = {
        candidate,
        snapshot: retry.snapshot,
        selectedIds: new Set(candidate.operations.map((operation) => operation.id)),
        request: retry.request,
      };
      this.messages.push(this.newMessage("assistant", candidate.summary, {
        ...response.generationMetadata,
        requestKind: "edit",
        finishReason: response.finishReason,
        actualServiceTier: response.actualServiceTier,
        generationState: "complete",
        usage: response.usage,
        noteHash: retry.snapshot.hash,
        target: context.target,
      }));
      await this.persistConversation(retry.snapshot);
    } catch (error) {
      if (generation === null || generation === this.requestGeneration) {
        this.errorMessage = this.describeError(error);
      }
    } finally {
      if (generation === null || generation === this.requestGeneration) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async applyProposal(proposal: PendingProposal): Promise<void> {
    if (!this.bound) return;
    try {
      const view = this.plugin.documentGate.assertCurrent(this.bound);
      const currentText = view.editor.getValue();
      if (currentText !== proposal.snapshot.text) {
        throw new CurrentDocumentError(
          "The note changed after this proposal was generated. Regenerate it against the current text.",
        );
      }

      const { afterText, operations } = compileSelectedOperations(
        proposal.candidate,
        proposal.selectedIds,
      );
      const end = view.editor.offsetToPos(currentText.length);
      view.editor.transaction({
        changes: [{ from: { line: 0, ch: 0 }, to: end, text: afterText }],
      }, "current-note-ai");

      if (view.editor.getValue() !== afterText) {
        throw new CurrentDocumentError(
          "Obsidian did not produce the expected document after the edit transaction. Review the note before continuing.",
        );
      }

      this.lastApplied = {
        binding: this.bound,
        beforeText: currentText,
        afterText,
      };
      this.pendingProposal = null;
      this.errorMessage = "";
      this.messages.push(this.newMessage(
        "assistant",
        `Applied ${operations.length} reviewed edit${operations.length === 1 ? "" : "s"}.`,
        { origin: "local" },
      ));
      new Notice("Current Note AI applied the selected edits.");
      this.render();
    } catch (error) {
      this.errorMessage = this.describeError(error);
      this.render();
      return;
    }

    try {
      await this.persistConversation();
    } catch (error) {
      this.errorMessage = `The note was modified successfully, but Current Note AI history was not saved: ${this.describeError(error)} Use Retry save; Revert AI edit remains available.`;
    }
    this.render();
  }

  private async revertLastApplied(): Promise<void> {
    const applied = this.lastApplied;
    if (!applied) return;
    try {
      const view = this.plugin.documentGate.assertCurrent(applied.binding);
      const currentText = view.editor.getValue();
      if (currentText !== applied.afterText) {
        throw new CurrentDocumentError(
          "The note changed after the AI edit, so automatic revert is disabled to protect the newer work.",
        );
      }
      const end = view.editor.offsetToPos(currentText.length);
      view.editor.transaction({
        changes: [{ from: { line: 0, ch: 0 }, to: end, text: applied.beforeText }],
      }, "current-note-ai-revert");
      if (view.editor.getValue() !== applied.beforeText) {
        throw new CurrentDocumentError("The revert result did not match the saved pre-edit snapshot.");
      }
      this.lastApplied = null;
      this.messages.push(this.newMessage("assistant", "Reverted the last AI edit.", { origin: "local" }));
      this.errorMessage = "";
      new Notice("Current Note AI reverted the last AI edit.");
      this.render();
    } catch (error) {
      this.errorMessage = this.describeError(error);
      this.render();
      return;
    }

    try {
      await this.persistConversation();
    } catch (error) {
      this.errorMessage = `The note was reverted successfully, but Current Note AI history was not saved: ${this.describeError(error)} Use Retry save.`;
    }
    this.render();
  }

  private isProposalStale(proposal: PendingProposal): boolean {
    if (!this.bound) return true;
    try {
      const view = this.plugin.documentGate.assertCurrent(this.bound);
      return view.editor.getValue() !== proposal.snapshot.text;
    } catch {
      return true;
    }
  }

  private newMessage(
    role: ConversationMessage["role"],
    content: string,
    metadata: Partial<Omit<ConversationMessage, "id" | "role" | "content" | "createdAt">> = {},
  ): ConversationMessage {
    this.messageSequence += 1;
    return {
      id: `${Date.now()}-${this.messageSequence}`,
      role,
      content,
      createdAt: Date.now(),
      ...metadata,
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof ProviderRequestError) {
      const provider = PROVIDER_PRESETS[error.providerId].displayName;
      if (error.providerId === "chatgpt" || error.providerId === "kimi-code") return error.message;
      if (error.status === 401) return `${provider} rejected the API key. Choose a valid ${provider} secret in plugin settings.`;
      if (error.status === 402) return `The ${provider} account has insufficient balance.`;
      if (error.status === 404) return `${provider} does not provide the selected model to this account.`;
      if (error.status === 429) return `${provider} rate-limited this request. Retry manually later.`;
      if (error.status && error.status >= 500) return `${provider} is temporarily unavailable. No automatic retry was made.`;
      return error.message;
    }
    if (error instanceof EditProposalError || error instanceof CurrentDocumentError) {
      return error.message;
    }
    return error instanceof Error ? error.message : "The request failed unexpectedly.";
  }
}
