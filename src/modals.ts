import { App, Modal } from "obsidian";

export class FullNoteConsentModal extends Modal {
  private settle: ((accepted: boolean) => void) | null = null;
  private resolved = false;

  constructor(
    app: App,
    private readonly providerName: string,
    private readonly providerHost: string,
    private readonly includesCrossProviderHistory: boolean,
  ) {
    super(app);
  }

  request(): Promise<boolean> {
    return new Promise((resolve) => {
      this.settle = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("current-note-ai-consent");
    contentEl.createEl("h3", { text: "Send the full current note?" });
    contentEl.createEl("p", {
      text: `Current Note AI will send the complete Markdown source of the bound note and this in-memory conversation to ${this.providerName} (${this.providerHost}).`,
    });
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: "Includes unsaved text and frontmatter." });
    list.createEl("li", { text: "Does not expand embeds, links, attachments, or other notes." });
    list.createEl("li", { text: "Opening the sidebar alone never sends data." });
    if (this.includesCrossProviderHistory) {
      list.createEl("li", {
        text: `The conversation includes replies created by another AI provider; their visible text will also be sent to ${this.providerName}.`,
      });
    }

    const actions = contentEl.createDiv({ cls: "current-note-ai-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = actions.createEl("button", {
      text: "Allow and send",
      cls: "mod-cta",
    });
    confirm.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false, false);
  }

  private finish(accepted: boolean, close = true): void {
    if (this.resolved) return;
    this.resolved = true;
    this.settle?.(accepted);
    this.settle = null;
    if (close) this.close();
  }
}
