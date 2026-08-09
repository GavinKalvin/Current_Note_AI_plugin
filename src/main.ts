import { MarkdownView, Notice, Plugin } from "obsidian";
import { CurrentDocumentGate } from "./context";
import {
  sanitizeConversationHistory,
  upsertConversationHistory,
} from "./core/conversation-history";
import { DeepSeekAdapter } from "./provider/deepseek";
import {
  CurrentNoteAiSettingTab,
  DEFAULT_SETTINGS,
  type CurrentNoteAiSettings,
  type SettingsHost,
} from "./settings";
import { CURRENT_NOTE_AI_VIEW, CurrentNoteAiView } from "./view";
import type { SavedConversation } from "./types";

export default class CurrentNoteAiPlugin extends Plugin implements SettingsHost {
  settings: CurrentNoteAiSettings = {
    ...DEFAULT_SETTINGS,
    availableModels: [...DEFAULT_SETTINGS.availableModels],
    conversationHistory: [],
  };
  readonly provider = new DeepSeekAdapter();
  readonly documentGate = new CurrentDocumentGate(this.app);

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
      if (info instanceof MarkdownView) this.notifyOpenViews();
    }));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(CURRENT_NOTE_AI_VIEW);
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<CurrentNoteAiSettings> | null;
    const savedModels = Array.isArray(saved?.availableModels)
      ? saved.availableModels.filter((model): model is string => (
        typeof model === "string" && model.trim().length > 0
      ))
      : [];
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
      availableModels: [...new Set([
        ...DEFAULT_SETTINGS.availableModels,
        ...savedModels.map((model) => model.trim()),
      ])],
      conversationHistory: sanitizeConversationHistory(saved?.conversationHistory),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      .filter((model) => model.length > 0))];
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
}
