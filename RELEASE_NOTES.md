# Current Note AI v0.1.6

> 本版本完成 Kimi 适配：支持独立 Kimi 账户档案、与 DeepSeek 并列选模，以及中国区/国际区 API 路由。

Current Note AI v0.1.6 adapts the plugin to Kimi alongside DeepSeek while preserving safe migration and rollback compatibility.

## Highlights

- DeepSeek and Kimi appear together in one model dropdown; there is no separate provider selector.
- Settings support multiple independent DeepSeek and Kimi account profiles, each with its own SecretStorage reference, model catalog, connection test, enabled state, and consent.
- The first Kimi release supports `kimi-k2.6` after `/models` verification.
- Kimi profiles explicitly select the China (`https://api.moonshot.cn/v1`) or International (`https://api.moonshot.ai/v1`) API region. Existing unlabelled profiles migrate to China, fixing China-region keys that previously returned `Invalid Authentication` against the international endpoint.
- API keys are never silently retried against another region. Changing region invalidates the old catalog, selection, profile revision, and consent.
- Profile-scoped privacy consent covers cross-provider history disclosure, and each conversation message retains its profile/provider/model source.
- Provider catalog refreshes do not block one another; failed refreshes keep the last successful catalog.
- Legacy v0.1.5 settings migrate without loss and retain rollback-compatible shadow fields plus a one-time pre-upgrade settings snapshot.
- Temperature applies only to DeepSeek. Kimi is non-streaming, disables thinking, and uses a 120-second local timeout.

## DeepSeek behavior

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
- Requests use a conservative provider/model-aware context estimate and block over-budget payloads before network access; both adapters enforce a 120-second local timeout.
- History is bounded to 5 MiB per session and 20 MiB total, supports deleting one/all sessions, and follows note renames.

## Install

1. Download `current-note-ai-0.1.6.zip`.
2. Extract it into `<vault>/.obsidian/plugins/current-note-ai/`.
3. Confirm that the directory contains `main.js`, `manifest.json`, and `styles.css`.
4. Enable or reload **Current Note AI** in Obsidian's third-party plugin settings.

Minimum Obsidian version: 1.13.0. Desktop only.

## Validation

- TypeScript type check and 97 repository tests cover Kimi region migration and isolation, provider profiles, prompt boundaries, completion usage, continuation overlap, history migration, edit schema safety, keyboard shortcuts, persistence hardening, and Markdown rendering.
- Production bundle should be rebuilt and installed before release.

See `README.md`, `CHANGELOG.md`, and `docs/ARCHITECTURE.md` for details.
