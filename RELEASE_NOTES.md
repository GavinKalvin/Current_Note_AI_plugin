# Current Note AI v0.1.5

Current Note AI v0.1.5 adds explicit output-budget control and safe recovery when DeepSeek stops at the generation limit.

## Highlights

- DeepSeek discussion and edit requests now explicitly use non-thinking mode instead of inheriting the provider default.
- The system prompt prioritizes the conclusion, reserves room to finish cleanly, and requires disclosure of material that did not fit.
- Incomplete discussion replies retain their raw content, show a separate status, and offer a manual **Continue** action bound to the same note snapshot.
- Continue is a new paid request and is capped at two attempts; automatic continuation remains disabled.
- Edit JSON uses schema v2 with `complete` and `needs_segmentation` states.
- Truncated and `needs_segmentation` edit responses never become proposals. One explicit higher-budget full regeneration may be offered against the same note hash.
- Token usage now includes reasoning-token details when DeepSeek returns them; raw reasoning content is not stored or displayed.
- Legacy truncation warnings are migrated out of saved assistant message content when History loads.
- History writes are revision-serialized with an explicit **Retry save** action; Apply/Revert success and history-save failure are reported separately.
- Editor changes update only stale/revert state, while rendered Markdown HTML is cached to preserve scroll position.
- Requests use a conservative 64,000-token estimate and block over-budget payloads before network access; `requestUrl` has a 120-second local timeout.
- History is bounded to 5 MiB per session and 20 MiB total, supports deleting one/all sessions, and follows note renames.

## Install

1. Download `current-note-ai-0.1.5.zip`.
2. Extract it into `<vault>/.obsidian/plugins/current-note-ai/`.
3. Confirm that the directory contains `main.js`, `manifest.json`, and `styles.css`.
4. Enable or reload **Current Note AI** in Obsidian's third-party plugin settings.

Minimum Obsidian version: 1.13.0. Desktop only.

## Validation

- TypeScript type check and the repository test suite cover prompt boundaries, completion usage, continuation overlap, history migration, edit schema safety, keyboard shortcuts, persistence hardening, and Markdown rendering.
- Production bundle should be rebuilt and installed before release.

See `README.md`, `CHANGELOG.md`, and `docs/ARCHITECTURE.md` for details.
