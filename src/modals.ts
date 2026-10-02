import { App, Modal, Notice } from "obsidian";
import { startChatGptSignIn } from "./provider/chatgpt-auth";

export class ChatGptPlanWelcomeModal extends Modal {
  onOpen(): void {
    this.contentEl.createEl("h2", { text: "You’re using your ChatGPT plan" });
    this.contentEl.createEl("p", { text: "Eligible Current Note AI requests use your shared ChatGPT plan allowance. Extra credits may be used if you enable them for this app. This does not grant access to your existing ChatGPT conversations." });
    const link = this.contentEl.createEl("a", { text: "Manage usage and app permissions" });
    link.href = "https://chatgpt.com/settings/usage";
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");
    this.contentEl.createEl("button", { text: "Got it", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

export class ManualChatGptSignInModal extends Modal {
  private cancelFlow: (() => void) | null = null;
  private settled = false;

  constructor(
    app: App,
    private readonly accountId: string,
    private readonly onSuccess: (result: { email: string; firstSignIn: boolean }) => void,
    private readonly onError: (error: unknown) => void,
    private readonly onCancel: () => void = () => undefined,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Continue with ChatGPT" });
    contentEl.createEl("p", { text: "Open this sign-in link in your browser, complete OpenAI sign-in, then return here. This plugin will not open a browser automatically." });
    const linkHolder = contentEl.createEl("p", { text: "Preparing a secure sign-in link…" });
    void startChatGptSignIn(this.accountId).then((flow) => {
      if (this.settled) { flow.cancel(); return; }
      this.cancelFlow = flow.cancel;
      linkHolder.empty();
      const anchor = linkHolder.createEl("a", { text: "OpenAI sign-in link" });
      anchor.href = flow.url;
      anchor.setAttr("target", "_blank");
      anchor.setAttr("rel", "noopener noreferrer");
      const copy = contentEl.createEl("button", { text: "Copy sign-in link" });
      copy.addEventListener("click", () => {
        if (!navigator.clipboard) { new Notice("Clipboard access is unavailable."); return; }
        void navigator.clipboard.writeText(flow.url).then(() => new Notice("Sign-in link copied."))
          .catch(() => new Notice("Could not copy the sign-in link."));
      });
      void flow.result.then((result) => {
        if (this.settled) return;
        this.settled = true;
        this.cancelFlow = null;
        this.close();
        this.onSuccess(result);
      }).catch((error) => {
        if (this.settled) return;
        this.settled = true;
        this.close();
        this.onError(error);
      });
    }).catch((error) => {
      if (this.settled) return;
      this.settled = true;
      this.close();
      this.onError(error);
    });
    contentEl.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    const wasPending = !this.settled;
    this.settled = true;
    this.cancelFlow?.();
    this.cancelFlow = null;
    this.contentEl.empty();
    if (wasPending) this.onCancel();
  }
}

export class FullNoteConsentModal extends Modal {
  private settle: ((accepted: boolean) => void) | null = null;
  private resolved = false;

  constructor(
    app: App,
    private readonly profileLabel: string,
    private readonly providerName: string,
    private readonly destination: string,
    private readonly includesCrossProviderHistory: boolean,
    private readonly usesLocalCli = false,
    private readonly usesChatGptPlan = false,
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
      text: `Current Note AI will send the complete Markdown source of the bound note and this in-memory conversation to the ${this.profileLabel} profile (${this.providerName}) at ${this.destination}.`,
    });
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: "Includes unsaved text and frontmatter." });
    list.createEl("li", { text: "Does not expand embeds, links, attachments, or other notes." });
    list.createEl("li", { text: "Opening the sidebar alone never sends data." });
    if (this.usesLocalCli) {
      list.createEl("li", { text: "Uses your official local Kimi Code CLI membership login and quota, not a plugin API key. Inference still runs in Kimi cloud." });
      list.createEl("li", { text: "The CLI also retains the supplied note/conversation in its own local session records. The private temporary prompt file is removed after the request." });
      list.createEl("li", { text: "The assistant has no file, shell, MCP, or agent tools. Edits remain proposals that require your approval in this plugin." });
    }
    if (this.usesChatGptPlan) {
      list.createEl("li", { text: "The current note and included conversation will be sent to OpenAI through the official ChatGPT plan service." });
      list.createEl("li", { text: "Usage is shared with your ChatGPT plan and app limits; credits may be used if enabled in ChatGPT settings. No API-key fallback is used." });
    }
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
