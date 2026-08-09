import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from "obsidian";
import { compileSelectedOperations, EditProposalError, validateEditProposal } from "./core/edit-proposal";
import { createConversationTitle } from "./core/conversation-history";
import { shouldSubmitComposer } from "./core/composer-shortcut";
import { buildDiscussionMessages, buildEditMessages } from "./core/prompt";
import type { BoundMarkdownDocument } from "./context";
import { CurrentDocumentError } from "./context";
import { FullNoteConsentModal } from "./modals";
import { ProviderRequestError } from "./provider/deepseek";
import type CurrentNoteAiPlugin from "./main";
import type {
  ConversationMessage,
  DocumentSnapshot,
  EditProposalCandidate,
  SavedConversation,
} from "./types";

export const CURRENT_NOTE_AI_VIEW = "current-note-ai-view";
const MAX_DOCUMENT_CHARACTERS = 1_500_000;

interface PendingProposal {
  candidate: EditProposalCandidate;
  snapshot: DocumentSnapshot;
  selectedIds: Set<string>;
  request: string;
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
  private lastApplied: AppliedChange | null = null;
  private draft = "";
  private errorMessage = "";
  private busy = false;
  private modelLoading = false;
  private historyOpen = false;
  private activeConversationId: string | null = null;
  private activeConversationTitle = "";
  private activeConversationCreatedAt = 0;
  private activeConversationNotePath = "";
  private activeConversationNoteName = "";
  private requestGeneration = 0;
  private messageSequence = 0;

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
    this.messages = [];
    this.pendingProposal = null;
    this.lastApplied = null;
    this.activeConversationId = null;
  }

  handleWorkspaceContextChanged(): void {
    if (!this.contentEl.isConnected) return;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("current-note-ai-view");

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
      });
    }

    const timeline = contentEl.createDiv({ cls: "current-note-ai-timeline" });
    if (this.messages.length === 0 && !this.pendingProposal) {
      const empty = timeline.createDiv({ cls: "current-note-ai-empty" });
      empty.createDiv({ cls: "current-note-ai-empty-icon", text: "✦" });
      empty.createEl("strong", { text: "Discuss the note in front of you" });
      empty.createEl("p", {
        text: "Send a question for analysis, or request a reviewed edit proposal. Nothing is written until you apply it.",
      });
    }

    for (const message of this.messages) this.renderMessage(timeline, message);
    if (this.busy) this.renderTypingBubble(timeline);
    if (this.pendingProposal) this.renderProposal(timeline, this.pendingProposal);

    this.renderComposer(contentEl);
    window.setTimeout(() => {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "current-note-ai-header" });
    const title = header.createDiv({ cls: "current-note-ai-brand" });
    const titleRow = title.createDiv({ cls: "current-note-ai-title-row" });
    titleRow.createEl("strong", { text: "Current Note AI" });
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
    modelBar.createSpan({ cls: "current-note-ai-provider", text: "DeepSeek" });

    const modelSelect = modelBar.createEl("select", {
      cls: "current-note-ai-model-select",
      attr: {
        "aria-label": "DeepSeek model",
        title: "Model used for the next DeepSeek request",
      },
    });
    const modelOptions = [...new Set([
      this.plugin.settings.model,
      ...this.plugin.settings.availableModels,
    ].filter((model) => model.trim().length > 0))];
    for (const model of modelOptions) {
      modelSelect.createEl("option", { text: model, value: model });
    }
    modelSelect.value = this.plugin.settings.model;
    modelSelect.disabled = this.busy || this.modelLoading;
    modelSelect.addEventListener("change", () => {
      void this.chooseModel(modelSelect.value);
    });

    const refreshModels = modelBar.createEl("button", {
      cls: "current-note-ai-model-refresh clickable-icon",
      text: this.modelLoading ? "…" : "↻",
      attr: {
        "aria-label": "Refresh DeepSeek models",
        title: "Refresh models from DeepSeek (does not send note content)",
      },
    });
    refreshModels.disabled = this.busy || this.modelLoading;
    refreshModels.addEventListener("click", () => void this.refreshModels());

    const actions = header.createDiv({ cls: "current-note-ai-header-actions" });
    if (this.busy) {
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.cancelLogicalRequest());
    }
    if (this.lastApplied) {
      const revert = actions.createEl("button", { text: "Revert AI edit" });
      revert.addEventListener("click", () => void this.revertLastApplied());
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

    const list = panel.createDiv({ cls: "current-note-ai-history-list" });
    for (const conversation of history) {
      const item = list.createEl("button", {
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
    }
  }

  private loadConversation(conversation: SavedConversation): void {
    this.requestGeneration += 1;
    this.busy = false;
    this.messages = conversation.messages.map((message) => ({ ...message }));
    this.pendingProposal = null;
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

  private async chooseModel(model: string): Promise<void> {
    try {
      await this.plugin.selectModel(model);
      this.errorMessage = "";
    } catch (error) {
      this.errorMessage = this.describeError(error);
    }
    this.render();
  }

  private async refreshModels(): Promise<void> {
    if (this.busy || this.modelLoading) return;
    this.modelLoading = true;
    this.errorMessage = "";
    this.render();
    try {
      await this.plugin.refreshModels();
      new Notice("DeepSeek model list refreshed.");
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

    if (!this.bound) {
      row.createDiv({ text: "No Markdown note is bound." });
    } else {
      const details = row.createDiv();
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
        cls: "mod-cta",
      });
      button.disabled = !current || this.busy;
      button.addEventListener("click", () => this.bindToCurrent());
    } else {
      row.createDiv({ cls: "current-note-ai-context-ready", text: "Bound" });
    }
  }

  private renderMessage(container: HTMLElement, message: ConversationMessage): void {
    const row = container.createDiv({
      cls: `current-note-ai-message-row is-${message.role}`,
    });
    const bubble = row.createDiv({ cls: "current-note-ai-bubble" });
    bubble.setText(message.content);
  }

  private renderTypingBubble(container: HTMLElement): void {
    const row = container.createDiv({ cls: "current-note-ai-message-row is-assistant" });
    const bubble = row.createDiv({ cls: "current-note-ai-bubble is-typing" });
    bubble.createSpan();
    bubble.createSpan();
    bubble.createSpan();
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
    heading.createDiv({
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
      const checkbox = summary.createEl("input", { type: "checkbox" });
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
    textarea.disabled = this.busy || historyMismatch;
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
    actions.createDiv({
      cls: "current-note-ai-composer-hint",
      text: "↵ send · ⇧↵ newline",
    });
    const buttons = actions.createDiv({ cls: "current-note-ai-composer-buttons" });
    const propose = buttons.createEl("button", { text: "Propose changes" });
    propose.disabled = this.busy || historyMismatch;
    propose.addEventListener("click", () => void this.requestEditProposal());
    const send = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
    send.disabled = this.busy || historyMismatch;
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
    this.pendingProposal = null;
    this.lastApplied = null;
    this.errorMessage = "";
    this.draft = "";
    this.historyOpen = false;
    this.resetConversationMetadata();
    this.render();
  }

  private cancelLogicalRequest(): void {
    this.requestGeneration += 1;
    this.busy = false;
    this.errorMessage = "The response will be ignored. DeepSeek may already be processing the request remotely.";
    this.render();
  }

  private async ensureConsent(): Promise<boolean> {
    if (this.plugin.settings.consentAcknowledged) return true;
    const accepted = await new FullNoteConsentModal(this.app).request();
    if (!accepted) return false;
    this.plugin.settings.consentAcknowledged = true;
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

  private hasHistoryBindingMismatch(): boolean {
    return this.activeConversationId !== null
      && this.activeConversationNotePath.length > 0
      && this.bound?.filePath !== this.activeConversationNotePath;
  }

  private resetConversationState(): void {
    this.messages = [];
    this.pendingProposal = null;
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
    if (!request || this.busy) return;
    let generation: number | null = null;

    try {
      if (!await this.ensureConsent()) return;
      const snapshot = this.captureCurrentSnapshot();
      const history = this.messages.slice();
      this.messages.push(this.newMessage("user", request));
      this.draft = "";
      this.errorMessage = "";
      this.busy = true;
      generation = ++this.requestGeneration;
      await this.persistConversation(snapshot);
      this.render();

      const response = await this.plugin.provider.complete(this.plugin.getApiKey(), {
        messages: buildDiscussionMessages(snapshot.text, history, request),
        options: {
          model: this.plugin.settings.model,
          maxTokens: this.plugin.settings.maxTokens,
          temperature: this.plugin.settings.temperature,
          responseFormat: "text",
        },
      });
      if (generation !== this.requestGeneration) return;

      const suffix = response.finishReason === "length"
        ? "\n\n[Response stopped because the output limit was reached.]"
        : "";
      this.messages.push(this.newMessage("assistant", `${response.content}${suffix}`));
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
    if (!request || this.busy) return;
    let generation: number | null = null;

    try {
      if (!await this.ensureConsent()) return;
      const snapshot = this.captureCurrentSnapshot();
      const history = this.messages.slice();
      this.messages.push(this.newMessage("user", request));
      this.draft = "";
      this.errorMessage = "";
      this.pendingProposal = null;
      this.busy = true;
      generation = ++this.requestGeneration;
      await this.persistConversation(snapshot);
      this.render();

      const response = await this.plugin.provider.complete(this.plugin.getApiKey(), {
        messages: buildEditMessages(snapshot.text, history, request),
        options: {
          model: this.plugin.settings.model,
          maxTokens: this.plugin.settings.maxTokens,
          temperature: this.plugin.settings.temperature,
          responseFormat: "json",
        },
      });
      if (generation !== this.requestGeneration) return;
      if (response.finishReason !== "stop") {
        throw new ProviderRequestError(
          "incomplete-response",
          `DeepSeek ended the edit response with finish_reason=${response.finishReason}; no editable proposal was created.`,
        );
      }

      const candidate = validateEditProposal(response.content, snapshot.text, {
        maxOperations: this.plugin.settings.maxOperations,
        maxChangeRatio: this.plugin.settings.maxChangeRatio,
      });
      this.pendingProposal = {
        candidate,
        snapshot,
        selectedIds: new Set(candidate.operations.map((operation) => operation.id)),
        request,
      };
      this.messages.push(this.newMessage("assistant", candidate.summary));
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
      ));
      await this.persistConversation();
      new Notice("Current Note AI applied the selected edits.");
    } catch (error) {
      this.errorMessage = this.describeError(error);
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
      this.messages.push(this.newMessage("assistant", "Reverted the last AI edit."));
      await this.persistConversation();
      this.errorMessage = "";
      new Notice("Current Note AI reverted the last AI edit.");
    } catch (error) {
      this.errorMessage = this.describeError(error);
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
  ): ConversationMessage {
    this.messageSequence += 1;
    return {
      id: `${Date.now()}-${this.messageSequence}`,
      role,
      content,
      createdAt: Date.now(),
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof ProviderRequestError) {
      if (error.status === 401) return "DeepSeek rejected the API key. Choose a valid secret in plugin settings.";
      if (error.status === 402) return "The DeepSeek account has insufficient balance.";
      if (error.status === 429) return "DeepSeek rate-limited this request. Retry manually later.";
      if (error.status && error.status >= 500) return "DeepSeek is temporarily unavailable. No automatic retry was made.";
      return error.message;
    }
    if (error instanceof EditProposalError || error instanceof CurrentDocumentError) {
      return error.message;
    }
    return error instanceof Error ? error.message : "The request failed unexpectedly.";
  }
}
