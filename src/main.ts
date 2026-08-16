import { MarkdownView, normalizePath, Notice, Plugin, TFile } from "obsidian";
import { CurrentDocumentGate } from "./context";
import {
  renameConversationHistoryNote,
  upsertConversationHistory,
} from "./core/conversation-history";
import { RevisionedSaveCoordinator } from "./core/persistence";
import { sanitizeSettings } from "./core/settings-sanitization";
import { ProfileRoutingError, ProviderRequestError } from "./provider/errors";
import { getProviderRegistration } from "./provider/registry";
import {
  CurrentNoteAiSettingTab,
  DEFAULT_SETTINGS,
  type CurrentNoteAiSettings,
  type SettingsHost,
} from "./settings";
import { CURRENT_NOTE_AI_VIEW, CurrentNoteAiView } from "./view";
import type {
  FrozenRequestTarget,
  ModelRef,
  ProfileModelRef,
  ProviderProfile,
  ProviderAdapter,
  ProviderId,
  ProviderModel,
  SavedConversation,
} from "./types";
import {
  createProfileId,
  defaultEndpointId,
  findProfile,
  freezeTarget,
  getProviderEndpoint,
  LEGACY_DEEPSEEK_PROFILE_ID,
  LEGACY_KIMI_PROFILE_ID,
  MAX_PROVIDER_PROFILES,
  nextProfileLabel,
} from "./core/provider-profiles";

const KIMI_SUPPORTED_MODEL = "kimi-k2.6";
const KIMI_CONTEXT_WINDOW_TOKENS = 256_000;
const DEEPSEEK_FALLBACK_CONTEXT_WINDOW_TOKENS = 64_000;
const LEGACY_ROLLBACK_FILE = "data.v0.1.6.rollback.json";

export interface ProviderRequestContext {
  profile: ProviderProfile;
  profileModel: ProfileModelRef;
  target: FrozenRequestTarget;
  /** Kept as a compatibility alias while request call sites migrate. */
  model: ModelRef;
  adapter: ProviderAdapter;
  displayName: string;
  destination: string;
  contextWindowTokens: number;
}

export interface ProviderRefreshResult {
  profileId: string;
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
    providerProfiles: settings.providerProfiles.map((profile) => ({
      ...profile,
      catalog: {
        ...profile.catalog,
        models: profile.catalog.models.map((model) => ({ ...model })),
      },
    })),
    selectedProfileModel: settings.selectedProfileModel
      ? { ...settings.selectedProfileModel }
      : null,
    profileConsents: Object.fromEntries(Object.entries(settings.profileConsents).map(([id, consent]) => [id, { ...consent }])),
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
    providerProfiles: DEFAULT_SETTINGS.providerProfiles.map((profile) => ({
      ...profile,
      catalog: {
        ...profile.catalog,
        models: profile.catalog.models.map((model) => ({ ...model })),
      },
    })),
    selectedProfileModel: DEFAULT_SETTINGS.selectedProfileModel
      ? { ...DEFAULT_SETTINGS.selectedProfileModel }
      : null,
    profileConsents: {},
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
    const raw = await this.loadData();
    await this.backupLegacySettings(raw);
    this.settings = sanitizeSettings(raw, DEFAULT_SETTINGS);
  }

  private async backupLegacySettings(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion === 3 && record.migrationVersion === 3) return;

    const path = normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/${LEGACY_ROLLBACK_FILE}`,
    );
    if (await this.app.vault.adapter.exists(path)) return;

    const serialized = JSON.stringify(raw, null, 2);
    await this.app.vault.adapter.write(path, serialized);
    const verified = await this.app.vault.adapter.read(path);
    if (verified !== serialized) {
      throw new Error("Current Note AI could not verify its pre-upgrade settings backup; migration was stopped.");
    }
  }

  async saveSettings(): Promise<void> {
    this.updateLegacyShadows();
    this.saveCoordinator.markDirty();
    await this.saveCoordinator.flush();
  }

  get hasPendingSave(): boolean {
    return this.saveCoordinator.isDirty;
  }

  async retryPendingSave(): Promise<void> {
    await this.saveCoordinator.flush();
  }

  getApiKey(profileId: string): string {
    const profile = this.requireEnabledProfile(profileId);
    if (!profile.secretId) {
      throw new ProfileRoutingError(
        "missing-secret",
        `Choose a ${getProviderRegistration(profile.providerId).displayName} API key secret for ${profile.label}.`,
        profile.id,
      );
    }
    const apiKey = this.app.secretStorage.getSecret(profile.secretId);
    if (!apiKey) {
      throw new ProfileRoutingError(
        "missing-secret",
        `The selected ${getProviderRegistration(profile.providerId).displayName} API key secret for ${profile.label} is empty or unavailable.`,
        profile.id,
      );
    }
    return apiKey;
  }

  async addProfile(providerId: ProviderId): Promise<string> {
    this.requireProvider(providerId);
    if (this.settings.providerProfiles.length >= MAX_PROVIDER_PROFILES) {
      throw new Error(`You can configure at most ${MAX_PROVIDER_PROFILES} provider profiles.`);
    }
    const id = createProfileId(new Set(this.settings.providerProfiles.map((profile) => profile.id)));
    const profile: ProviderProfile = {
      id,
      label: nextProfileLabel(this.settings.providerProfiles, providerId),
      providerId,
      endpointId: defaultEndpointId(providerId),
      secretId: "",
      enabled: true,
      revision: 1,
      catalog: { models: [], lastSuccessfulRefreshAt: 0 },
    };
    this.settings.providerProfiles = [...this.settings.providerProfiles, profile];
    await this.saveSettings();
    this.notifyOpenViews();
    return id;
  }

  async updateProfile(
    profileId: string,
    changes: Partial<Pick<ProviderProfile, "label" | "secretId" | "enabled" | "endpointId">>,
  ): Promise<void> {
    const profile = this.requireProfile(profileId);
    const label = changes.label === undefined ? profile.label : changes.label.trim();
    const secretId = changes.secretId === undefined ? profile.secretId : changes.secretId.trim();
    if (!label || label.length > 200) throw new Error("Choose a profile label between 1 and 200 characters.");
    if (secretId.length > 500) throw new Error("Choose a valid vault secret reference.");
    if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") {
      throw new Error("Profile enabled must be a boolean.");
    }
    const endpointId = changes.endpointId ?? profile.endpointId;
    getProviderEndpoint(profile.providerId, endpointId);
    const changed = label !== profile.label
      || secretId !== profile.secretId
      || endpointId !== profile.endpointId
      || (changes.enabled !== undefined && changes.enabled !== profile.enabled);
    if (!changed) return;
    const identityChanged = secretId !== profile.secretId
      || endpointId !== profile.endpointId
      || (changes.enabled !== undefined && changes.enabled !== profile.enabled);
    const next = {
      ...profile,
      label,
      secretId,
      endpointId,
      ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
      revision: identityChanged ? profile.revision + 1 : profile.revision,
      catalog: identityChanged
        ? { models: [], lastSuccessfulRefreshAt: 0 }
        : profile.catalog,
    };
    this.settings.providerProfiles = this.settings.providerProfiles.map((candidate) => candidate.id === profileId ? next : candidate);
    if (identityChanged) {
      delete this.settings.profileConsents[profileId];
      if (this.settings.selectedProfileModel?.profileId === profileId) this.settings.selectedProfileModel = null;
    }
    this.updateLegacyShadows();
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.requireProfile(profileId);
    this.settings.providerProfiles = this.settings.providerProfiles.filter((profile) => profile.id !== profileId);
    delete this.settings.profileConsents[profileId];
    if (this.settings.selectedProfileModel?.profileId === profileId) this.settings.selectedProfileModel = null;
    this.updateLegacyShadows();
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async moveProfile(profileId: string, direction: -1 | 1): Promise<void> {
    this.requireProfile(profileId);
    const index = this.settings.providerProfiles.findIndex((profile) => profile.id === profileId);
    const target = index + direction;
    if (target < 0 || target >= this.settings.providerProfiles.length) return;
    const profiles = [...this.settings.providerProfiles];
    const [profile] = profiles.splice(index, 1);
    if (profile) profiles.splice(target, 0, profile);
    this.settings.providerProfiles = profiles;
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async resetProfileConsent(profileId: string): Promise<void> {
    this.requireProfile(profileId);
    delete this.settings.profileConsents[profileId];
    await this.saveSettings();
    this.notifyOpenViews();
  }

  resolveRequestContext(
    model: ProfileModelRef | FrozenRequestTarget | ModelRef | null = this.settings.selectedProfileModel,
  ): ProviderRequestContext {
    const target = this.resolveFrozenTarget(model);
    const profile = this.requireEnabledProfile(target.profileId);
    if (profile.revision !== target.profileRevision) {
      throw new ProfileRoutingError("revision-mismatch", `Profile ${profile.label} changed; select its model again.`, profile.id);
    }
    if (profile.providerId !== target.providerId) {
      throw new ProfileRoutingError("revision-mismatch", `Profile ${profile.label} no longer matches the selected provider.`, profile.id);
    }
    const descriptor = profile.catalog.models.find((candidate) => candidate.id === target.modelId);
    if (!descriptor || (profile.providerId === "kimi" && target.modelId !== KIMI_SUPPORTED_MODEL)) {
      throw new ProfileRoutingError("unknown-model", `Model ${target.modelId} is not in the last successful model list for ${profile.label}.`, profile.id);
    }
    const endpoint = getProviderEndpoint(profile.providerId, profile.endpointId);
    const adapter = getProviderRegistration(profile.providerId).createAdapter(endpoint.baseUrl);
    const remoteContext = descriptor.contextWindowTokens;
    const contextWindowTokens = profile.providerId === "kimi"
      ? Math.min(remoteContext ?? KIMI_CONTEXT_WINDOW_TOKENS, KIMI_CONTEXT_WINDOW_TOKENS)
      : remoteContext ?? DEEPSEEK_FALLBACK_CONTEXT_WINDOW_TOKENS;
    const profileModel = { profileId: profile.id, modelId: target.modelId };
    return {
      profile,
      profileModel,
      target: freezeTarget(profile, target.modelId),
      model: { providerId: profile.providerId, modelId: target.modelId },
      adapter,
      displayName: adapter.displayName,
      destination: endpoint.baseUrl,
      contextWindowTokens,
    };
  }

  async selectModel(model: ProfileModelRef | ModelRef): Promise<void> {
    const context = this.resolveRequestContext(model);
    this.settings.selectedProfileModel = { ...context.profileModel };
    this.updateLegacyShadows();
    await this.saveSettings();
    this.notifyOpenViews();
  }

  async refreshModels(): Promise<ProviderRefreshSummary> {
    const results = await Promise.all(
      this.settings.providerProfiles
        .filter((profile) => profile.enabled)
        .map((profile) => this.refreshProvider(profile.id)),
    );
    if (results.some((result) => result.status === "updated")) {
      await this.saveSettings();
      this.notifyOpenViews();
    }
    return { results };
  }

  async testConnection(profileId: string): Promise<string[]> {
    this.requireEnabledProfile(profileId);
    // Surface local configuration errors with their stable routing code and
    // guarantee that no adapter call can happen for an absent secret.
    this.getApiKey(profileId);
    const result = await this.refreshProvider(profileId);
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

  private requireProvider(providerId: ProviderId): void {
    if (providerId !== "deepseek" && providerId !== "kimi") {
      throw new ProfileRoutingError("invalid-selection", "Choose a recognized AI provider.");
    }
    getProviderRegistration(providerId);
  }

  private requireProfile(profileId: string): ProviderProfile {
    const profile = findProfile(this.settings.providerProfiles, profileId);
    if (!profile) {
      throw new ProfileRoutingError("missing-profile", `Provider profile ${profileId} was not found.`, profileId);
    }
    this.requireProvider(profile.providerId);
    return profile;
  }

  private requireEnabledProfile(profileId: string): ProviderProfile {
    const profile = this.requireProfile(profileId);
    if (!profile.enabled) {
      throw new ProfileRoutingError("disabled-profile", `Provider profile ${profile.label} is disabled.`, profile.id);
    }
    return profile;
  }

  private resolveFrozenTarget(
    model: ProfileModelRef | FrozenRequestTarget | ModelRef | null,
  ): FrozenRequestTarget {
    if (!model) {
      throw new ProfileRoutingError("invalid-selection", "Choose a provider profile and model before sending a request.");
    }
    if ("profileId" in model) {
      const profile = this.requireProfile(model.profileId);
      const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
      if (!modelId || modelId.length > 200) {
        throw new ProfileRoutingError("invalid-selection", "Choose a valid model.", profile.id);
      }
      const revision = "profileRevision" in model ? model.profileRevision : profile.revision;
      if (typeof revision !== "number" || revision !== profile.revision) {
        throw new ProfileRoutingError("revision-mismatch", `Profile ${profile.label} changed; select its model again.`, profile.id);
      }
      return {
        profileId: profile.id,
        profileRevision: revision,
        providerId: "providerId" in model ? model.providerId : profile.providerId,
        modelId,
      };
    }
    // Compatibility for pre-profile request call sites: only the deterministic
    // legacy profile for that provider is eligible; no arbitrary fallback occurs.
    if (model.providerId !== "deepseek" && model.providerId !== "kimi") {
      throw new ProfileRoutingError("invalid-selection", "Choose a recognized AI provider.");
    }
    const profileId = model.providerId === "deepseek"
      ? LEGACY_DEEPSEEK_PROFILE_ID
      : LEGACY_KIMI_PROFILE_ID;
    const profile = this.requireProfile(profileId);
    return {
      profileId,
      profileRevision: profile.revision,
      providerId: profile.providerId,
      modelId: typeof model.modelId === "string" ? model.modelId.trim() : "",
    };
  }

  /** Keep rollback fields coherent only when their profile identity is deterministic. */
  private updateLegacyShadows(): void {
    const deepseek = this.settings.providerProfiles.find((profile) => profile.id === LEGACY_DEEPSEEK_PROFILE_ID);
    const kimi = this.settings.providerProfiles.find((profile) => profile.id === LEGACY_KIMI_PROFILE_ID);
    if (deepseek) {
      this.settings.secretId = deepseek.secretId;
      this.settings.providerCatalogs.deepseek = {
        models: deepseek.catalog.models.map((model) => ({ ...model })),
        lastSuccessfulRefreshAt: deepseek.catalog.lastSuccessfulRefreshAt,
      };
      this.settings.availableModels = deepseek.catalog.models.map((model) => model.id);
    }
    if (kimi) {
      this.settings.kimiSecretId = kimi.secretId;
      this.settings.providerCatalogs.kimi = {
        models: kimi.catalog.models.map((model) => ({ ...model })),
        lastSuccessfulRefreshAt: kimi.catalog.lastSuccessfulRefreshAt,
      };
    }
    // Legacy consent fields are shadows of the deterministic legacy profiles;
    // duplicate/non-legacy accounts never modify them.
    const deepseekConsent = deepseek ? this.settings.profileConsents[deepseek.id] : undefined;
    const kimiConsent = kimi ? this.settings.profileConsents[kimi.id] : undefined;
    if (deepseekConsent) {
      this.settings.providerConsents.deepseek = {
        disclosureRevision: deepseekConsent.disclosureRevision,
        acceptedAt: deepseekConsent.acceptedAt,
      };
    } else {
      delete this.settings.providerConsents.deepseek;
    }
    if (kimiConsent) {
      this.settings.providerConsents.kimi = {
        disclosureRevision: kimiConsent.disclosureRevision,
        acceptedAt: kimiConsent.acceptedAt,
      };
    } else {
      delete this.settings.providerConsents.kimi;
    }
    const selected = this.settings.selectedProfileModel;
    const selectedProfile = selected
      ? this.settings.providerProfiles.find((profile) => profile.id === selected.profileId)
      : undefined;
    if (selected && selectedProfile && (selectedProfile.id === LEGACY_DEEPSEEK_PROFILE_ID || selectedProfile.id === LEGACY_KIMI_PROFILE_ID)) {
      this.settings.selectedModel = { providerId: selectedProfile.providerId, modelId: selected.modelId };
      if (selectedProfile.id === LEGACY_DEEPSEEK_PROFILE_ID) this.settings.model = selected.modelId;
    }
    // `consentAcknowledged` is a legacy DeepSeek-only shadow.
    this.settings.consentAcknowledged = Boolean(this.settings.providerConsents.deepseek);
  }

  private async refreshProvider(profileId: string): Promise<ProviderRefreshResult> {
    const profile = this.requireProfile(profileId);
    const providerId = profile.providerId;
    const endpoint = getProviderEndpoint(providerId, profile.endpointId);
    const adapter = getProviderRegistration(providerId).createAdapter(endpoint.baseUrl);
    if (!profile.enabled) {
      return {
        profileId: profile.id, providerId, displayName: adapter.displayName, status: "skipped",
        models: profile.catalog.models.map((model) => model.id), excludedCount: 0,
        error: `${profile.label} is disabled.`,
      };
    }
    let apiKey: string;
    try {
      apiKey = this.getApiKey(profile.id);
    } catch (error) {
      return {
        profileId: profile.id,
        providerId,
        displayName: adapter.displayName,
        status: "skipped",
        models: profile.catalog.models.map((model) => model.id),
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

      profile.catalog = {
        models: compatible,
        lastSuccessfulRefreshAt: Date.now(),
      };
      this.updateLegacyShadows();
      return {
        profileId: profile.id,
        providerId,
        displayName: adapter.displayName,
        status: "updated",
        models: compatible.map((model) => model.id),
        excludedCount: discovered.length - compatible.length,
      };
    } catch (error) {
      return {
        profileId: profile.id,
        providerId,
        displayName: adapter.displayName,
        status: "failed",
        models: profile.catalog.models.map((model) => model.id),
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
