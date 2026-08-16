# Changelog

All notable changes to Current Note AI are documented here.

## Unreleased

No unreleased changes.

## 0.1.7 - 2026-08-16

### Changed

- Redesign the conversation view with a clearer visual hierarchy, refined message bubbles, context and proposal cards, improved focus states, and reduced-motion support while retaining Obsidian theme compatibility.
- Make the header, context row, composer actions, proposal controls, and buttons wrap safely in narrow sidebars so **Use current note** and other controls remain inside the panel.
- Change the composer shortcut contract to Enter for a newline and Shift+Enter to send, including numpad and legacy Electron Enter handling while preserving IME composition safety.

### Fixed

- Remove the disabled **Choose a profile and model** option from the model selector instead of merely hiding or renaming its text.
- Keep history deletion visible and accessible at compact widths and improve long-text wrapping throughout the conversation view.

## 0.1.6 - 2026-08-16

### Added

- Adapt Current Note AI to Kimi alongside DeepSeek, with `/models`-verified `kimi-k2.6` support.
- Add ordered multi-account profiles for DeepSeek and Kimi, each with an independent SecretStorage reference, model catalog, connection test, consent, and enabled state.
- Group every enabled profile in the existing single model selector and freeze the selected profile/model for discussion, edit, continuation, and edit retry requests.
- Add explicit Kimi China (`api.moonshot.cn`) and International (`api.moonshot.ai`) endpoint presets per profile. Existing unlabelled Kimi profiles migrate to China; keys are never silently retried across regions.
- Add schema-v3 migration plus a one-time v0.1.6 settings rollback snapshot.
- Show DeepSeek and Kimi models together in the same model dropdown; no separate provider selector is added.
- Add independent API key and `/models` connection testing for DeepSeek and Kimi. The first Kimi release supports only `kimi-k2.6`, after it is verified by `/models`.
- Add provider-level privacy consent, cross-provider history disclosure, and provider/model attribution on conversation messages.
- Refresh provider catalogs independently; a failed refresh keeps the last successful catalog.

### Changed

- Migrate legacy v0.1.5 DeepSeek settings without loss and retain rollback-compatible DeepSeek shadow fields.
- Temperature applies to DeepSeek only. Kimi requests are non-streaming with thinking disabled and a 120-second local timeout.

### Security

- Fail closed when a frozen profile is missing, disabled, changed, unconfigured, or no longer exposes its model; never fall back to another account.
- Keep provider destinations in the code-owned adapter registry. Arbitrary custom endpoints remain unsupported.
- Changing a Kimi API region advances the profile revision and clears its cached models, selection, and consent before the new destination can be used.

## 0.1.5 - 2026-08-15

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
