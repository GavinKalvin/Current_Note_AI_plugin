import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import type { SavedConversation } from "./types";

export interface CurrentNoteAiSettings {
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
  testConnection(): Promise<string[]>;
}

export class CurrentNoteAiSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
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
          await this.host.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("This model is also selectable from the top of the AI sidebar. Use Test connection to refresh the available list.")
      .addText((text) => text
        .setPlaceholder("deepseek-v4-flash")
        .setValue(this.host.settings.model)
        .onChange(async (value) => {
          this.host.settings.model = value.trim();
          await this.host.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Queries DeepSeek /models without sending note content.")
      .addButton((button) => button
        .setButtonText("Test")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            const models = await this.host.testConnection();
            new Notice(`DeepSeek connected. Available models: ${models.join(", ")}`);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "DeepSeek connection failed.");
          } finally {
            button.setDisabled(false).setButtonText("Test");
          }
        }));

    new Setting(containerEl)
      .setName("Maximum output tokens")
      .setDesc(`${this.host.settings.maxTokens} per request. Incomplete discussions can be continued; incomplete edits may offer one bounded higher-budget retry.`)
      .addSlider((slider) => slider
        .setLimits(512, 16_384, 512)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxTokens)
        .onChange(async (value) => {
          this.host.settings.maxTokens = value;
          await this.host.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(`${this.host.settings.temperature.toFixed(1)} · requests explicitly use non-thinking mode so this setting is effective`)
      .addSlider((slider) => slider
        .setLimits(0, 1.5, 0.1)
        .setDynamicTooltip()
        .setValue(this.host.settings.temperature)
        .onChange(async (value) => {
          this.host.settings.temperature = value;
          await this.host.saveSettings();
          this.display();
        }));

    new Setting(containerEl).setName("Edit safety").setHeading();

    new Setting(containerEl)
      .setName("Maximum operations")
      .setDesc(String(this.host.settings.maxOperations))
      .addSlider((slider) => slider
        .setLimits(1, 50, 1)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxOperations)
        .onChange(async (value) => {
          this.host.settings.maxOperations = value;
          await this.host.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Maximum changed portion")
      .setDesc(`${Math.round(this.host.settings.maxChangeRatio * 100)}% of the note`)
      .addSlider((slider) => slider
        .setLimits(0.1, 1, 0.05)
        .setDynamicTooltip()
        .setValue(this.host.settings.maxChangeRatio)
        .onChange(async (value) => {
          this.host.settings.maxChangeRatio = value;
          await this.host.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Full-note disclosure")
      .setDesc("Show the consent dialog again before the next request.")
      .addButton((button) => button
        .setButtonText("Reset consent")
        .onClick(async () => {
          this.host.settings.consentAcknowledged = false;
          await this.host.saveSettings();
          new Notice("Consent will be requested again before sending note content.");
        }));
  }
}
