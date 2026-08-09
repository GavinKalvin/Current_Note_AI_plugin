import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import { hashText } from "./core/hash";
import type { DocumentSnapshot } from "./types";

export interface BoundMarkdownDocument {
  leaf: WorkspaceLeaf;
  file: TFile;
  filePath: string;
}

export class CurrentDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrentDocumentError";
  }
}

export class CurrentDocumentGate {
  constructor(private readonly app: App) {}

  getCurrent(): BoundMarkdownDocument | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.file) return null;
    return {
      leaf,
      file: leaf.view.file,
      filePath: leaf.view.file.path,
    };
  }

  assertCurrent(binding: BoundMarkdownDocument): MarkdownView {
    const current = this.getCurrent();
    if (
      !current
      || current.leaf !== binding.leaf
      || current.file !== binding.file
      || current.filePath !== binding.filePath
    ) {
      throw new CurrentDocumentError(
        "The main editor is showing a different note. Bind the sidebar to the current note first.",
      );
    }

    if (!(binding.leaf.view instanceof MarkdownView) || !binding.leaf.view.file) {
      throw new CurrentDocumentError("The bound Markdown editor is no longer available.");
    }
    if (
      binding.leaf.view.file !== binding.file
      || binding.leaf.view.file.path !== binding.filePath
    ) {
      throw new CurrentDocumentError("The bound note was renamed or replaced. Bind it again.");
    }

    return binding.leaf.view;
  }

  capture(binding: BoundMarkdownDocument): DocumentSnapshot {
    const view = this.assertCurrent(binding);
    const text = view.editor.getValue();
    return {
      text,
      hash: hashText(text),
      filePath: binding.filePath,
      capturedAt: Date.now(),
    };
  }
}
