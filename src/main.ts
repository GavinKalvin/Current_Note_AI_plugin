import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { CurrentDocumentGate } from "./context";
import {
  renameConversationHistoryNote,
  upsertConversationHistory,
} from "./core/conversation-history";
import { RevisionedSaveCoordinator } from "./core/persistence";
import { sanitizeSettings } from "./core/settings-sanitization";
import { DeepSeekAdapter } from "./provider/deepseek";
import {
  CurrentNoteAiSettingTab,
  DEFAULT_SETTINGS,
  type CurrentNoteAiSettings,
  type SettingsHost,
} from "./settings";
import { CURRENT_NOTE_AI_VIEW, CurrentNoteAiView } from "./view";
import type { SavedConversation } from "./types";

function cloneSettings(settings: CurrentNoteAiSettings): CurrentNoteAiSettings {
  return {
    ...settings,
    availableModels: [...settings.availableModels],
    conversationHistory: settings.conversationHistory.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        usage: message.usage ? { ...message.usage } : undefined,
      })),
    })),
  };
}

export default class CurrentNoteAiPlugin extends Plugin implements SettingsHost {
  settings: CurrentNoteAiSettings = {
    ...DEFAULT_SETTINGS,
    availableModels: [...DEFAULT_SETTINGS.availableModels],
    conversationHistory: [],
  };
  readonly provider = new DeepSeekAdapter();
  readonly documentGate = new CurrentDocumentGate(this.app);
  private readonly saveCoordinator = new RevisionedSaveCoordinator<CurrentNoteAiSettings>({
    getSnapshot: () => cloneSettings(this.settings),
    writeSnapshot: (snapshot) => this.saveData(snapshot),
  });

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      CURRENT_NOTE_AI_VIEW,
      (leaf) => new CurrentNoteAiView(leaf, this),
    );

    this.addRibbonIcon("message-circle", "Open Current Note AI", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-current-note-ai",
      name: "Open AI sidebar for current note",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "bind-current-note-ai",
      name: "Bind AI sidebar to current Markdown note",
      callback: async () => {
        await this.activateView();
        this.notifyOpenViews();
      },
    });

    this.addSettingTab(new CurrentNoteAiSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.notifyOpenViews();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info instanceof MarkdownView) this.notifyEditorChanged(info);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        void this.handleFileRename(file, oldPath).catch((error: unknown) => {
          new Notice(error instanceof Error
            ? `Current Note AI updated the renamed note in memory but could not save it: ${error.message}`
            : "Current Note AI could not save renamed-note history metadata.");
        });
      }
    }));
  }

  onunload(): void {
    if (this.saveCoordinator.isDirty) {
      void this.saveCoordinator.flush().catch((error: unknown) => {
        new Notice(error instanceof Error
          ? `Current Note AI still has unsaved local data: ${error.message}`
          : "Current Note AI still has unsaved local data.");
      });
    }
    this.app.workspace.detachLeavesOfType(CURRENT_NOTE_AI_VIEW);
  }

  async loadSettings(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData(), DEFAULT_SETTINGS);
  }

  async saveSettings(): Promise<void> {
    this.saveCoordinator.markDirty();
    await this.saveCoordinator.flush();
  }

  get hasPendingSave(): boolean {
    return this.saveCoordinator.isDirty;
  }

  async retryPendingSave(): Promise<void> {
    await this.saveCoordinator.flush();
  }

  getApiKey(): string {
    if (!this.settings.secretId) {
      throw new Error("Choose a DeepSeek API key secret in Current Note AI settings.");
    }
    const apiKey = this.app.secretStorage.getSecret(this.settings.secretId);
    if (!apiKey) {
      throw new Error("The selected DeepSeek API key secret is empty or unavailable.");
    }
    return apiKey;
  }

  async selectModel(model: string): Promise<void> {
    const normalized = model.trim();
    if (!normalized) throw new Error("Choose a non-empty DeepSeek model name.");

    this.settings.model = normalized;
    if (!this.settings.availableModels.includes(normalized)) {
      this.settings.availableModels = [...this.settings.availableModels, normalized];
    }
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async refreshModels(): Promise<string[]> {
    const models = await this.provider.listModels(this.getApiKey());
    const modelIds = [...new Set(models
      .map((model) => model.id.trim())
      .filter((model) => model.length > 0 && model.length <= 200))]
      .slice(0, 100);
    if (modelIds.length === 0) throw new Error("DeepSeek returned no available models.");

    this.settings.availableModels = modelIds;
    await this.saveSettings();
    this.notifyOpenViews();

    if (!modelIds.includes(this.settings.model)) {
      new Notice(`Configured model ${this.settings.model} is not in the current DeepSeek model list.`);
    }
    return modelIds;
  }

  async testConnection(): Promise<string[]> {
    return this.refreshModels();
  }

  async upsertConversation(conversation: SavedConversation): Promise<void> {
    this.settings.conversationHistory = upsertConversationHistory(
      this.settings.conversationHistory,
      conversation,
    );
    await this.saveSettings();
  }

  async deleteConversation(id: string): Promise<void> {
    const next = this.settings.conversationHistory.filter((conversation) => conversation.id !== id);
    if (next.length === this.settings.conversationHistory.length) return;
    this.settings.conversationHistory = next;
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async clearConversationHistory(): Promise<void> {
    if (this.settings.conversationHistory.length === 0) return;
    this.settings.conversationHistory = [];
    await this.saveSettings();
    this.notifyOpenViews();
  }

  private async activateView(): Promise<void> {
    const leaf = await this.app.workspace.ensureSideLeaf(CURRENT_NOTE_AI_VIEW, "right", {
      active: true,
      reveal: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private notifyOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CURRENT_NOTE_AI_VIEW)) {
      if (leaf.view instanceof CurrentNoteAiView) {
        leaf.view.handleWorkspaceContextChanged();
      }
    }
  }

  private notifyEditorChanged(editorView: MarkdownView): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CURRENT_NOTE_AI_VIEW)) {
      if (leaf.view instanceof CurrentNoteAiView) {
        leaf.view.handleEditorContentChanged(editorView);
      }
    }
  }

  private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
    const renamed = renameConversationHistoryNote(
      this.settings.conversationHistory,
      oldPath,
      file.path,
      file.basename,
    );
    this.settings.conversationHistory = renamed.history;

    for (const leaf of this.app.workspace.getLeavesOfType(CURRENT_NOTE_AI_VIEW)) {
      if (leaf.view instanceof CurrentNoteAiView) {
        leaf.view.handleNoteRenamed(file, oldPath);
      }
    }
    if (renamed.changed) await this.saveSettings();
  }
}
