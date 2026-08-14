export async function requestUrl(): Promise<never> {
  throw new Error("Tests must mock obsidian.requestUrl before use.");
}

class FakeElement {
  isConnected = true;
  win = globalThis;
  empty(): void {}
  addClass(): void {}
  createEl(): FakeElement { return new FakeElement(); }
  createDiv(): FakeElement { return new FakeElement(); }
  addEventListener(): void {}
}

export class ItemView {
  contentEl = new FakeElement();
  constructor(public leaf: unknown) {}
  addAction(): void {}
}

export class Modal {
  contentEl = new FakeElement();
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}

export class MarkdownView {}

export class TFile {
  constructor(public path = "note.md", public basename = "note") {}
}

export class WorkspaceLeaf {}

export class Notice {
  constructor(public message: string) {}
}
