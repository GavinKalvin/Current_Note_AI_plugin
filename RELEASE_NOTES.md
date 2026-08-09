# Current Note AI v0.1.3

The first public release of Current Note AI, a desktop-only Obsidian plugin for discussing and safely revising the currently bound Markdown note with DeepSeek.

## Highlights

- iMessage-style sidebar discussion using the complete unsaved Markdown source of the bound current note.
- DeepSeek model selector and note-free `/models` refresh control.
- Automatically named local History with note-binding checks before a conversation can continue.
- Structured edit proposals with per-operation review and selective Apply.
- Exact snapshot, unique-anchor, overlap, operation-count, and change-budget validation.
- Safe Revert only while the note still matches the known AI-edited result.
- Enter, Command+Enter, Ctrl+Enter, and numpad Enter send; Shift+Enter inserts a newline.
- API keys stored through Obsidian SecretStorage rather than plugin `data.json`.

## Install

1. Download `current-note-ai-0.1.3.zip` below.
2. Extract it into `<vault>/.obsidian/plugins/current-note-ai/`.
3. Confirm that the directory contains `main.js`, `manifest.json`, and `styles.css`.
4. Enable **Current Note AI** in Obsidian's third-party plugin settings.

Minimum Obsidian version: 1.13.0. Desktop only.

## Privacy boundary

Opening the sidebar, selecting a cached model, loading History, or reviewing/applying an edit does not send note content. Send and Propose changes transmit the complete bound Markdown snapshot and relevant conversation context to DeepSeek after user consent. The plugin does not search the Vault, expand links or embeds, expose model-callable tools, run commands, or collect telemetry.

Conversation history is stored locally in plugin `data.json` and may contain private material. The API key itself remains in Obsidian SecretStorage.

## Validation

- TypeScript type check passed.
- 31 Vitest tests passed across editing safety, prompt boundaries, history persistence, and keyboard shortcuts.
- Production bundle built and verified in Obsidian 1.13.4 on macOS.

See `README.md`, `SECURITY.md`, and `docs/ARCHITECTURE.md` for full details.
