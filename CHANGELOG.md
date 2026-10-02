# Changelog

All notable changes to Current Note AI are documented here.

## Unreleased

No unreleased changes.

## 0.1.14 - 2026-10-02

- Upgrade Markdown rendering to `markdown-it` 15.0.2 before publishing the accumulated provider and conversation UI improvements. This includes the linkification denial-of-service fix for [GHSA-253c-mchw-3w2r](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-253c-mchw-3w2r) and the upstream smartquotes fix.
- Add regression coverage for long repeated soft-break email and unknown-scheme input with linkification enabled. Preserve selectable messages, original-Markdown Copy, offline math and generation-time answer metadata.

## 0.1.13 - 2026-10-02

- Show generation-time **Model / Reasoning** above each assistant answer, outside its bubble. Snapshot the actual request's model and requested reasoning before awaiting inference for Discussion, Continue, Edit and Edit retry; later header/profile changes cannot rewrite answer metadata.
- Show the locally received date/time to seconds below the bubble, with semantic `<time datetime>`, exact ISO/timezone tooltips, and the existing original-message **Copy** button. Preserve incomplete/Continue/speed status outside the bubble.
- Persist and validate reasoning/origin fields in conversation history. Older missing fields remain **Not recorded**, never inferred from current settings. Mark local Apply/Revert notifications explicitly as **Local action** instead of attributing them to an AI model.
- Incorporate Kimi Code **K3-256k**'s bounded UI review: compact metadata spacing, timestamp-left/Copy-right layout and accessibility grouping. Preserve long model identifiers by wrapping rather than hiding provenance; keep the iMessage-style bubbles and offline Markdown/math renderer.

## 0.1.12 - 2026-10-02

- Restore native text selection in user/assistant bubbles and the composer, overriding Obsidian's non-selectable UI default. Add an accessible **Copy** button per message that copies the exact original Markdown/LaTeX; clipboard failures are reported without exposing message text.
- Render user messages as well as assistant replies with the isolated Markdown renderer. Add explicit bold/italic styles, preserve safe code/table/list rendering and original stored content, and keep message HTML caching.
- Add offline KaTeX rendering for `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`; bundle scoped styles and WOFF2 fonts inside `main.js`, preserving the three-asset install. Long display equations scroll within the bubble. Invalid/oversized TeX remains readable instead of hiding the message.
- Disable trusted TeX commands, isolate macros per formula, and bound macro expansion and dimensions. Code, escaped delimiters and ordinary currency remain literal; raw HTML, executable links, remote images and Obsidian embeds remain inert.

## 0.1.11 - 2026-10-02

- Fix ChatGPT requests incorrectly rejected as “did not return the required event stream” when a successful response omits `Content-Type` despite containing valid SSE. Reproduced against a minimal note-free authenticated request.
- Recognize fragmented SSE framing when the MIME header is missing or mislabeled, normalize declared MIME casing, and handle a leading UTF-8 BOM. Continue requiring a valid completed terminal event; never treat JSON/HTML as a completed answer.
- Surface structured JSON errors even on HTTP 200 without exposing raw response bodies, credentials, or reasoning. Preserve abort, deadline, fixed-endpoint and bounded-output protections.

## 0.1.10 - 2026-10-02

- Supplement **GPT-6.1 Sol** (`gpt-6.1-sol`) in authenticated ChatGPT profiles when the account catalog omits it. Mark the option as manually added with unverified account access; preserve the current selection and never claim that UI presence grants entitlement.
- Keep the manual option across model refreshes and upgrades without duplicates. A live account-listed Sol replaces the manual metadata naturally. Preserve low/medium/high/xhigh/max reasoning and Standard/Fast selection; unsupported account access fails without fallback or retry.

## 0.1.9 - 2026-10-02

### Added

- Add **ChatGPT · Plan quota** as a fourth source through official Sign in with ChatGPT dynamic OAuth registration for open-source/local apps. No API key or reused Codex credentials are required; account eligibility and app limits remain controlled by OpenAI.
- Populate GPT models from the selected account's live plan catalog. Add manual sidebar **Reasoning** and **Speed** controls; preserve per-profile choices and report the actual service tier when returned. Standard/Fast are selectable; Ultrafast is unavailable on Plus. Unsupported selections fail without silent fallback.
- Provide manual browser authorization, private loopback callbacks, account display, sign-out, and Manage usage links. Do not automatically open a browser or foreground another app.

### Safety and limitations

- Validate PKCE, one-time state, nonce, signed ID tokens, issuer/audience/expiry, verified account identity, and plan-use scopes. Store credentials atomically outside the vault in machine-local owner-only files, serialize refreshes, and preserve registration after sign-out.
- Use fixed official `/v1/models` and `/v1/responses` endpoints with `store: false`, `stream: true`, and no tools. Only an explicit completed terminal event permits an edit proposal; incomplete, interrupted, malformed, or tool-bearing responses fail closed.
- ChatGPT plan usage is shared, not an independent unlimited allowance. Extra credits can be used if enabled in ChatGPT settings. The preview does not support `max_output_tokens`; the output slider is a soft prompt length target for this source. A conservative encoded 32k context budget applies.
- Use abortable desktop HTTPS with a 180-second local deadline, without inference retries or API billing fallback. OAuth and Responses fixtures are tested; real sign-in/inference still requires the user's separate authorization and account access.

## 0.1.8 - 2026-09-30

### Added

- Add **Kimi Code · Local quota** as a third source in the existing sidebar model selector, using the official locally installed Kimi Code CLI and its membership OAuth login instead of an API key stored by this plugin.
- Explicitly select only **K3-256k** (`kimi-code/k3-256k`); verify that this alias belongs to the managed membership provider. Never fall back to the Kimi Platform API or an unspecified K3 variant.
- Add CLI path discovery, an optional absolute executable path, and a note-free local configuration check. CLI 0.36.1+ is required; cloud entitlement and remaining quota are checked by the first real request, not the configuration check.

### Safety

- Use a private temporary working directory and a dedicated custom agent with all tools and subagents disabled. JSON-encode note/history data, prevent agent-template interpolation, and keep note text out of process arguments. Block enabled global CLI hooks, plugins, and MCP servers.
- Keep membership credentials in the official CLI. Disclose cloud inference and the CLI's additional local session history before sending notes; remove private temporary prompt files after each run without deleting the CLI's history.
- Terminate local CLI processes on Cancel, sidebar close, or a 180-second timeout. Remote processing/quota consumption already started cannot be undone.
- Preserve output-token budgets through the CLI, inspect only the newly created session's journal for finish reason/usage, and reject unknown or incomplete edit responses. Existing reviewed-edit, History, Continue, and frozen-profile protections also apply to the local source.
- Disable CLI telemetry for plugin-initiated runs, without changing the user's CLI configuration or client identity. The CLI may apply its own internal retry policy; the plugin never automatically retries a failed request.

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
