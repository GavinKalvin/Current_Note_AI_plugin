import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import type {
  ModelRef,
  ProfileConsentGrant,
  ProfileModelRef,
  ProviderConsentGrant,
  ProviderEndpointId,
  ProviderId,
  ProviderModelCatalog,
  ProviderProfile,
  SavedConversation,
} from "./types";
import {
  LEGACY_DEEPSEEK_PROFILE_ID,
  LEGACY_KIMI_PROFILE_ID,
  PROVIDER_PRESETS,
  PROVIDER_ENDPOINTS,
  getProviderEndpoint,
} from "./core/provider-profiles";

export interface CurrentNoteAiSettings {
  schemaVersion: 3;
  providerProfiles: ProviderProfile[];
  selectedProfileModel: ProfileModelRef | null;
  profileConsents: Record<string, ProfileConsentGrant>;
  migrationVersion: 3;
  // v0.1.6 shadow fields retained for rollback compatibility.
  selectedModel: ModelRef;
  kimiSecretId: string;
  providerCatalogs: Record<ProviderId, ProviderModelCatalog>;
  providerConsents: Partial<Record<ProviderId, ProviderConsentGrant>>;
  // Legacy DeepSeek shadow fields retained for rollback compatibility.
  secretId: string;
  model: string;
  availableModels: string[];
  conversationHistory: SavedConversation[];
  maxTokens: number;
  temperature: number;
  maxOperations: number;
  maxChangeRatio: number;
  consentAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: CurrentNoteAiSettings = {
  schemaVersion: 3,
  providerProfiles: [
    {
      id: LEGACY_DEEPSEEK_PROFILE_ID,
      label: "DeepSeek",
      providerId: "deepseek",
      endpointId: "deepseek-official",
      secretId: "",
      enabled: true,
      revision: 1,
      catalog: {
        models: [
          { id: "deepseek-v4-flash", contextWindowTokens: 64_000 },
          { id: "deepseek-v4-pro", contextWindowTokens: 64_000 },
        ],
        lastSuccessfulRefreshAt: 0,
      },
    },
    {
      id: LEGACY_KIMI_PROFILE_ID,
      label: "Kimi",
      providerId: "kimi",
      endpointId: "kimi-cn",
      secretId: "",
      enabled: true,
      revision: 1,
      catalog: { models: [], lastSuccessfulRefreshAt: 0 },
    },
  ],
  selectedProfileModel: {
    profileId: LEGACY_DEEPSEEK_PROFILE_ID,
    modelId: "deepseek-v4-flash",
  },
  profileConsents: {},
  migrationVersion: 3,
  selectedModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
  kimiSecretId: "",
  providerCatalogs: {
    deepseek: {
      models: [
        { id: "deepseek-v4-flash", contextWindowTokens: 64_000 },
        { id: "deepseek-v4-pro", contextWindowTokens: 64_000 },
      ],
      lastSuccessfulRefreshAt: 0,
    },
    kimi: {
      models: [],
      lastSuccessfulRefreshAt: 0,
    },
  },
  providerConsents: {},
  secretId: "",
  model: "deepseek-v4-flash",
  availableModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  conversationHistory: [],
  maxTokens: 4_096,
  temperature: 0.3,
  maxOperations: 20,
  maxChangeRatio: 0.5,
  consentAcknowledged: false,
};

export interface SettingsHost {
  settings: CurrentNoteAiSettings;
  saveSettings(): Promise<void>;
  addProfile(providerId: ProviderId): Promise<string>;
  updateProfile(
    profileId: string,
    changes: Partial<Pick<ProviderProfile, "label" | "secretId" | "enabled" | "endpointId">>,
  ): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;
  moveProfile(profileId: string, direction: -1 | 1): Promise<void>;
  resetProfileConsent(profileId: string): Promise<void>;
  testConnection(profileId: string): Promise<string[]>;
  selectModel(model: ProfileModelRef): Promise<void>;
}

export class CurrentNoteAiSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  private async saveWithNotice(): Promise<boolean> {
    try {
      await this.host.saveSettings();
      return true;
    } catch (error) {
      new Notice(error instanceof Error
        ? `Current Note AI could not save settings: ${error.message}`
        : "Current Note AI could not save settings.");
      return false;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Provider profiles")
      .setHeading();
    containerEl.createEl("p", {
      text: "Each profile keeps its own secret, model catalog, consent, and request history identity. API destinations use reviewed provider presets.",
    });
    const addActions = containerEl.createDiv({ cls: "current-note-ai-profile-add-actions" });
    for (const providerId of ["deepseek", "kimi"] as const) {
      const button = addActions.createEl("button", {
        text: `Add ${PROVIDER_PRESETS[providerId].displayName}`,
      });
      button.addEventListener("click", () => {
        void this.runProfileAction(async () => {
          await this.host.addProfile(providerId);
          this.display();
        });
      });
    }

    for (const [index, profile] of this.host.settings.providerProfiles.entries()) {
      this.renderProfileCard(containerEl, profile, index);
    }

    const maxTokensSetting = new Setting(containerEl)
      .setName("Maximum output tokens")
      .setDesc(`${this.host.settings.maxTokens} per request. Incomplete discussions can be continued; incomplete edits may offer one bounded higher-budget retry.`)
      .addSlider((slider) => slider
        .setLimits(512, 16_384, 512)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxTokens)
        .onChange(async (value) => {
          this.host.settings.maxTokens = value;
          maxTokensSetting.setDesc(`${value} per request. Incomplete discussions can be continued; incomplete edits may offer one bounded higher-budget retry.`);
          await this.saveWithNotice();
        }));

    const temperatureSetting = new Setting(containerEl)
      .setName("DeepSeek temperature")
      .setDesc(`${this.host.settings.temperature.toFixed(1)} · applies to DeepSeek requests only; Kimi uses a fixed request strategy`)
      .addSlider((slider) => slider
        .setLimits(0, 1.5, 0.1)
        .setDynamicTooltip()
        .setValue(this.host.settings.temperature)
        .onChange(async (value) => {
          this.host.settings.temperature = value;
          temperatureSetting.setDesc(`${value.toFixed(1)} · applies to DeepSeek requests only; Kimi uses a fixed request strategy`);
          await this.saveWithNotice();
        }));

    new Setting(containerEl).setName("Edit safety").setHeading();

    const maxOperationsSetting = new Setting(containerEl)
      .setName("Maximum operations")
      .setDesc(String(this.host.settings.maxOperations))
      .addSlider((slider) => slider
        .setLimits(1, 50, 1)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxOperations)
        .onChange(async (value) => {
          this.host.settings.maxOperations = value;
          maxOperationsSetting.setDesc(String(value));
          await this.saveWithNotice();
        }));

    const maxChangeRatioSetting = new Setting(containerEl)
      .setName("Maximum changed portion")
      .setDesc(`${Math.round(this.host.settings.maxChangeRatio * 100)}% of the note`)
      .addSlider((slider) => slider
        .setLimits(0.1, 1, 0.05)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxChangeRatio)
        .onChange(async (value) => {
          this.host.settings.maxChangeRatio = value;
          maxChangeRatioSetting.setDesc(`${Math.round(value * 100)}% of the note`);
          await this.saveWithNotice();
        }));

  }

  private renderProfileCard(container: HTMLElement, profile: ProviderProfile, index: number): void {
    const preset = PROVIDER_PRESETS[profile.providerId];
    const endpoint = getProviderEndpoint(profile.providerId, profile.endpointId);
    const card = container.createDiv({ cls: "current-note-ai-profile-card" });
    new Setting(card).setName(`${profile.label} · ${preset.displayName}`).setHeading();
    new Setting(card)
      .setName("Destination")
      .setDesc(`${preset.displayName} requests use ${endpoint.baseUrl}.`);
    if (profile.providerId === "kimi") {
      new Setting(card)
        .setName("API region")
        .setDesc("Choose the region where this API key was created. Keys are not retried against another region.")
        .addDropdown((dropdown) => {
          for (const endpointId of preset.endpointIds) {
            const candidate = PROVIDER_ENDPOINTS[endpointId];
            dropdown.addOption(candidate.id, `${candidate.displayName} · ${candidate.baseUrl}`);
          }
          dropdown
            .setValue(profile.endpointId)
            .onChange((value) => {
              void this.runProfileAction(async () => {
                await this.host.updateProfile(profile.id, { endpointId: value as ProviderEndpointId });
                this.display();
              });
            });
        });
    }
    new Setting(card)
      .setName("Profile label")
      .addText((text) => text
        .setValue(profile.label)
        .onChange((value) => {
          void this.runProfileAction(() => this.host.updateProfile(profile.id, { label: value }));
        }));
    new Setting(card)
      .setName("API key secret")
      .setDesc("Choose a vault-scoped secret. The key is never stored in plugin data.")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(profile.secretId)
        .onChange((value) => {
          void this.runProfileAction(() => this.host.updateProfile(profile.id, { secretId: value }));
        }));
    new Setting(card)
      .setName(profile.enabled ? "Enabled" : "Disabled")
      .setDesc(profile.enabled ? "Available for new requests." : "Excluded from model selection and refreshes.")
      .addToggle((toggle) => toggle
        .setValue(profile.enabled)
        .onChange((value) => {
          void this.runProfileAction(() => this.host.updateProfile(profile.id, { enabled: value }));
        }));
    const actions = new Setting(card).setName("Profile actions");
    actions.addButton((button) => button
      .setButtonText("Test connection")
      .onClick(async () => {
        button.setDisabled(true).setButtonText("Testing…");
        try {
          const models = await this.host.testConnection(profile.id);
          new Notice(`${profile.label} connected. Available models: ${models.join(", ")}`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Connection test failed.");
        } finally {
          button.setDisabled(false).setButtonText("Test connection");
        }
      }));
    actions.addButton((button) => button
      .setButtonText("Move up")
      .setDisabled(index === 0)
      .onClick(() => void this.runProfileAction(async () => {
        await this.host.moveProfile(profile.id, -1);
        this.display();
      })));
    actions.addButton((button) => button
      .setButtonText("Move down")
      .setDisabled(index === this.host.settings.providerProfiles.length - 1)
      .onClick(() => void this.runProfileAction(async () => {
        await this.host.moveProfile(profile.id, 1);
        this.display();
      })));
    actions.addButton((button) => button
      .setButtonText("Reset consent")
      .onClick(() => void this.runProfileAction(async () => {
        await this.host.resetProfileConsent(profile.id);
        new Notice(`${profile.label} consent will be requested again before sending note content.`);
      })));
    actions.addButton((button) => button
      .setButtonText("Delete")
      .setWarning()
      .onClick(() => {
        void this.runProfileAction(async () => {
          await this.host.deleteProfile(profile.id);
          this.display();
        });
      }));
  }

  private async runProfileAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not update provider profile.");
    }
  }
}
