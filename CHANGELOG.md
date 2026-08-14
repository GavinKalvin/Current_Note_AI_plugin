# Changelog

All notable changes to Current Note AI are documented here.

## 0.1.5 - Unreleased

### Added

- Add a budget-aware response contract that requires DeepSeek to disclose uncovered material instead of silently omitting it.
- Add a manual **Continue** action for discussion responses stopped by the output limit, with a maximum of two continuations.
- Add schema v2 edit responses with `complete` and `needs_segmentation` states.
- Add one explicit, bounded higher-budget retry for incomplete edit proposals.
- Persist finish reason, generation state, note hash, and numeric token usage separately from message text.
- Add bounded request estimation (64,000 tokens), local 120-second request timeout, history deletion, and note-rename rebinding.

### Changed

- Explicitly disable DeepSeek thinking mode for discussion and edit requests instead of inheriting the provider default.
- Parse reasoning-token usage without storing or displaying raw reasoning content.
- Keep UI truncation warnings out of assistant message content and migrate the legacy warning suffix when loading History.
- Serialize history writes by revision and offer an explicit **Retry save** when a save fails; separate edit success from history-save failure.
- Refresh only stale/revert state on editor changes and cache rendered Markdown HTML to preserve scroll position.
- Enforce 5 MiB per-session and 20 MiB total history limits, with full settings-field sanitization.

### Safety

- Continue is manual, note-snapshot-bound, paid-request-labelled, and capped at two attempts.
- Incomplete or `needs_segmentation` edit JSON is never parsed as an applicable proposal.
- An edit retry always regenerates a complete proposal against the same note hash and is offered at most once.
- Request budgets are conservative estimates rather than official tokenizer counts; over-budget requests are blocked before network access and are never silently truncated.
- Local timeout/Cancel stops waiting or ignores late results only; it does not claim to cancel remote processing or billing.

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
