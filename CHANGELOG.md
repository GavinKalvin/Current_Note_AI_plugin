# Changelog

All notable changes to Current Note AI are documented here.

## 0.1.4 - 2026-08-10

### Added

- Render assistant replies as Markdown, including headings, lists, tables, blockquotes, links, inline code, and fenced code blocks.

### Safety

- Parse replies in an isolated renderer instead of invoking Obsidian or third-party Markdown post-processors.
- Escape raw HTML, reject executable link protocols, and prevent Markdown or Obsidian embeds from loading content automatically.

## 0.1.3 - 2026-08-09

Initial public release.

### Added

- DeepSeek discussion for the complete Markdown source of the bound current note.
- Reviewed, structured edit proposals with local validation and selective apply.
- Safe one-step revert while the document still matches the applied result.
- Model selection in the sidebar and a note-free `/models` refresh action.
- Locally persisted, automatically named conversation history.
- Enter, Command+Enter, Ctrl+Enter, and numpad Enter submission; Shift+Enter newline.
- Obsidian SecretStorage integration for API keys.

### Safety

- No model-callable filesystem, command, vault-search, or network tools.
- Exact snapshot, file identity, unique anchor, overlap, operation-count, and change-ratio checks.
- No automatic writes, retries, or telemetry.
