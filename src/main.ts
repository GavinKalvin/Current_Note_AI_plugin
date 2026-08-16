import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { CurrentDocumentGate } from "./context";
import {
  renameConversationHistoryNote,
  upsertConversationHistory,
} from "./core/conversation-history";
import { RevisionedSaveCoordinator } from "./core/persistence";
import { sanitizeSettings } from "./core/settings-sanitization";
import { DeepSeekAdapter } from "./provider/deepseek";
import { ProviderRequestError } from "./provider/errors";
import { KimiAdapter } from "./provider/kimi";
import {
  CurrentNoteAiSettingTab,
  DEFAULT_SETTINGS,
  type CurrentNoteAiSettings,
  type SettingsHost,
} from "./settings";
import { CURRENT_NOTE_AI_VIEW, CurrentNoteAiView } from "./view";
import type {
  ModelRef,
  ProviderAdapter,
  ProviderId,
  ProviderModel,
  SavedConversation,
} from "./types";

const KIMI_SUPPORTED_MODEL = "kimi-k2.6";
const KIMI_CONTEXT_WINDOW_TOKENS = 256_000;
const DEEPSEEK_FALLBACK_CONTEXT_WINDOW_TOKENS = 64_000;

export interface ProviderRequestContext {
  model: ModelRef;
  adapter: ProviderAdapter;
  displayName: string;
  contextWindowTokens: number;
}

export interface ProviderRefreshResult {
  providerId: ProviderId;
  displayName: string;
  status: "updated" | "failed" | "skipped";
  models: string[];
  excludedCount: number;
  error?: string;
}

export interface ProviderRefreshSummary {
  results: ProviderRefreshResult[];
}

function cloneSettings(settings: CurrentNoteAiSettings): CurrentNoteAiSettings {
  return {
    ...settings,
    selectedModel: { ...settings.selectedModel },
    providerCatalogs: {
      deepseek: {
        ...settings.providerCatalogs.deepseek,
        models: settings.providerCatalogs.deepseek.models.map((model) => ({ ...model })),
      },
      kimi: {
        ...settings.providerCatalogs.kimi,
        models: settings.providerCatalogs.kimi.models.map((model) => ({ ...model })),
      },
    },
    providerConsents: {
      ...(settings.providerConsents.deepseek
        ? { deepseek: { ...settings.providerConsents.deepseek } }
        : {}),
      ...(settings.providerConsents.kimi
        ? { kimi: { ...settings.providerConsents.kimi } }
        : {}),
    },
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
    selectedModel: { ...DEFAULT_SETTINGS.selectedModel },
    providerCatalogs: {
      deepseek: {
        ...DEFAULT_SETTINGS.providerCatalogs.deepseek,
        models: DEFAULT_SETTINGS.providerCatalogs.deepseek.models.map((model) => ({ ...model })),
      },
      kimi: {
        ...DEFAULT_SETTINGS.providerCatalogs.kimi,
        models: DEFAULT_SETTINGS.providerCatalogs.kimi.models.map((model) => ({ ...model })),
      },
    },
    providerConsents: {},
    availableModels: [...DEFAULT_SETTINGS.availableModels],
    conversationHistory: [],
  };
  private readonly providers: Record<ProviderId, ProviderAdapter> = {
    deepseek: new DeepSeekAdapter(),
    kimi: new KimiAdapter(),
  };
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

  getApiKey(providerId: ProviderId): string {
    const provider = this.providers[providerId];
    const secretId = providerId === "deepseek"
      ? this.settings.secretId
      : this.settings.kimiSecretId;
    if (!secretId) {
      throw new Error(`Choose a ${provider.displayName} API key secret in Current Note AI settings.`);
    }
    const apiKey = this.app.secretStorage.getSecret(secretId);
    if (!apiKey) {
      throw new Error(`The selected ${provider.displayName} API key secret is empty or unavailable.`);
    }
    return apiKey;
  }

  resolveRequestContext(model: ModelRef = this.settings.selectedModel): ProviderRequestContext {
    const normalized = this.normalizeModelRef(model);
    const adapter = this.providers[normalized.providerId];
    const catalog = this.settings.providerCatalogs[normalized.providerId];
    const descriptor = catalog.models.find((candidate) => candidate.id === normalized.modelId);

    if (normalized.providerId === "kimi") {
      if (normalized.modelId !== KIMI_SUPPORTED_MODEL) {
        throw new Error(`Kimi model ${normalized.modelId} is not supported by this plugin version.`);
      }
      if (!descriptor) {
        throw new Error("Kimi K2.6 is not in the last successful model list. Test the Kimi connection first.");
      }
    }

    const remoteContext = descriptor?.contextWindowTokens;
    const contextWindowTokens = normalized.providerId === "kimi"
      ? Math.min(remoteContext ?? KIMI_CONTEXT_WINDOW_TOKENS, KIMI_CONTEXT_WINDOW_TOKENS)
      : remoteContext ?? DEEPSEEK_FALLBACK_CONTEXT_WINDOW_TOKENS;

    return {
      model: normalized,
      adapter,
      displayName: adapter.displayName,
      contextWindowTokens,
    };
  }

  async selectModel(model: ModelRef): Promise<void> {
    const normalized = this.normalizeModelRef(model);
    this.resolveRequestContext(normalized);

    this.settings.selectedModel = normalized;
    if (normalized.providerId === "deepseek") {
      this.settings.model = normalized.modelId;
      if (!this.settings.availableModels.includes(normalized.modelId)) {
        this.settings.availableModels = [...this.settings.availableModels, normalized.modelId];
      }
      const catalog = this.settings.providerCatalogs.deepseek;
      if (!catalog.models.some((candidate) => candidate.id === normalized.modelId)) {
        catalog.models = [...catalog.models, { id: normalized.modelId }];
      }
    }
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async refreshModels(): Promise<ProviderRefreshSummary> {
    const results = await Promise.all(
      (["deepseek", "kimi"] as const).map((providerId) => this.refreshProvider(providerId)),
    );
    if (results.some((result) => result.status === "updated")) {
      await this.saveSettings();
      this.notifyOpenViews();
    }
    return { results };
  }

  async testConnection(providerId: ProviderId): Promise<string[]> {
    const result = await this.refreshProvider(providerId);
    if (result.status !== "updated") {
      throw new Error(result.error ?? `${result.displayName} is not configured.`);
    }
    await this.saveSettings();
    this.notifyOpenViews();
    if (result.models.length === 0) {
      throw new Error(`${result.displayName} returned no models supported by this plugin version.`);
    }
    return result.models;
  }

  private normalizeModelRef(model: ModelRef): ModelRef {
    if (model.providerId !== "deepseek" && model.providerId !== "kimi") {
      throw new Error("Choose a recognized AI provider.");
    }
    const modelId = model.modelId.trim();
    if (!modelId || modelId.length > 200) {
      throw new Error(`Choose a valid ${this.providers[model.providerId].displayName} model.`);
    }
    return { providerId: model.providerId, modelId };
  }

  private async refreshProvider(providerId: ProviderId): Promise<ProviderRefreshResult> {
    const adapter = this.providers[providerId];
    let apiKey: string;
    try {
      apiKey = this.getApiKey(providerId);
    } catch (error) {
      return {
        providerId,
        displayName: adapter.displayName,
        status: "skipped",
        models: this.settings.providerCatalogs[providerId].models.map((model) => model.id),
        excludedCount: 0,
        error: error instanceof Error ? error.message : `${adapter.displayName} is not configured.`,
      };
    }

    try {
      const discovered = this.sanitizeProviderModels(await adapter.listModels(apiKey));
      const compatible = providerId === "kimi"
        ? discovered.filter((model) => model.id === KIMI_SUPPORTED_MODEL)
        : discovered;
      if (compatible.length === 0) {
        throw new ProviderRequestError(
          providerId,
          "list-models",
          providerId === "deepseek" ? "empty-model-list" : "no-compatible-model",
          providerId === "deepseek"
            ? "DeepSeek returned no available models."
            : "Kimi did not return kimi-k2.6 for this account. The last successful model list was kept.",
        );
      }

      this.settings.providerCatalogs[providerId] = {
        models: compatible,
        lastSuccessfulRefreshAt: Date.now(),
      };
      if (providerId === "deepseek") {
        this.settings.availableModels = compatible.map((model) => model.id);
      }
      return {
        providerId,
        displayName: adapter.displayName,
        status: "updated",
        models: compatible.map((model) => model.id),
        excludedCount: discovered.length - compatible.length,
      };
    } catch (error) {
      return {
        providerId,
        displayName: adapter.displayName,
        status: "failed",
        models: this.settings.providerCatalogs[providerId].models.map((model) => model.id),
        excludedCount: 0,
        error: error instanceof Error ? error.message : `${adapter.displayName} model refresh failed.`,
      };
    }
  }

  private sanitizeProviderModels(models: ProviderModel[]): ProviderModel[] {
    const seen = new Set<string>();
    const result: ProviderModel[] = [];
    for (const model of models) {
      const id = model.id.trim();
      if (!id || id.length > 200 || seen.has(id)) continue;
      seen.add(id);
      const contextWindowTokens = model.contextWindowTokens;
      result.push({
        id,
        ...(typeof model.ownedBy === "string" && model.ownedBy.length <= 200
          ? { ownedBy: model.ownedBy }
          : {}),
        ...(typeof contextWindowTokens === "number"
          && Number.isFinite(contextWindowTokens)
          && Number.isInteger(contextWindowTokens)
          && contextWindowTokens > 0
          && contextWindowTokens <= 2_000_000
          ? { contextWindowTokens }
          : {}),
        ...(typeof model.supportsReasoning === "boolean"
          ? { supportsReasoning: model.supportsReasoning }
          : {}),
      });
      if (result.length === 100) break;
    }
    return result;
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
