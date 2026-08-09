# Changelog

All notable changes to Current Note AI are documented here.

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
