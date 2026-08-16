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
  ProviderConsentGrant,
  ProviderId,
  ProviderModelCatalog,
  SavedConversation,
} from "./types";

export interface CurrentNoteAiSettings {
  schemaVersion: 2;
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
  schemaVersion: 2,
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
  testConnection(providerId: ProviderId): Promise<string[]>;
  selectModel(model: ModelRef): Promise<void>;
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

    new Setting(containerEl).setName("DeepSeek").setHeading();

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Choose or create a vault-scoped secret. The key is not stored in plugin data.json.")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.host.settings.secretId)
        .onChange(async (value) => {
          this.host.settings.secretId = value;
          await this.saveWithNotice();
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Enter a DeepSeek model ID. Use Test connection to verify the key and refresh the available list.")
      .addText((text) => text
        .setPlaceholder("deepseek-v4-flash")
        .setValue(this.host.settings.model)
        .onChange(async (value) => {
          const modelId = value.trim();
          if (!modelId) return;
          try {
            await this.host.selectModel({ providerId: "deepseek", modelId });
          } catch (error) {
            new Notice(error instanceof Error
              ? `DeepSeek model selection failed: ${error.message}`
              : "DeepSeek model selection failed.");
          }
        }));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Queries DeepSeek /models without sending note content.")
      .addButton((button) => button
        .setButtonText("Test")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            const models = await this.host.testConnection("deepseek");
            new Notice(`DeepSeek connected. Available models: ${models.join(", ")}`);
          } catch (error) {
            new Notice(error instanceof Error
              ? `DeepSeek connection failed: ${error.message}`
              : "DeepSeek connection failed.");
          } finally {
            button.setDisabled(false).setButtonText("Test");
          }
        }));

    new Setting(containerEl).setName("Kimi").setHeading();

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Choose or create a vault-scoped secret reference. The key is not stored in plugin data.json.")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.host.settings.kimiSecretId)
        .onChange(async (value) => {
          this.host.settings.kimiSecretId = value;
          await this.saveWithNotice();
        }));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Queries Kimi /models without sending note content. This plugin currently supports Kimi K2.6.")
      .addButton((button) => button
        .setButtonText("Test")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            const models = await this.host.testConnection("kimi");
            new Notice(`Kimi connected. Supported models: ${models.join(", ")}`);
          } catch (error) {
            new Notice(error instanceof Error
              ? `Kimi connection failed: ${error.message}`
              : "Kimi connection failed.");
          } finally {
            button.setDisabled(false).setButtonText("Test");
          }
        }));

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

    new Setting(containerEl)
      .setName("Full-note disclosure")
      .setDesc("Show the consent dialog again before the next request.")
      .addButton((button) => button
        .setButtonText("Reset DeepSeek consent")
        .onClick(async () => {
          delete this.host.settings.providerConsents.deepseek;
          this.host.settings.consentAcknowledged = false;
          if (await this.saveWithNotice()) {
            new Notice("DeepSeek consent will be requested again before sending note content.");
          }
        }))
      .addButton((button) => button
        .setButtonText("Reset Kimi consent")
        .onClick(async () => {
          delete this.host.settings.providerConsents.kimi;
          if (await this.saveWithNotice()) {
            new Notice("Kimi consent will be requested again before sending note content.");
          }
        }));
  }
}
