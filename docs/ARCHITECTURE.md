# Architecture and trust boundaries

## Objective

Current Note AI lets a user discuss or revise exactly one explicitly bound Markdown note through configured DeepSeek/Kimi API, Kimi Code membership, or ChatGPT plan profiles. Enabled profiles appear as groups in one model dropdown; there is no separate provider-selection button. GPT reasoning and Standard/Fast speed are profile-scoped manual choices. The provider may propose text, but it cannot choose a file, execute a command, search the Vault, or write directly to the editor.

## Request path

1. `CurrentDocumentGate` binds a concrete Obsidian `WorkspaceLeaf`, `TFile`, and path.
2. Immediately before a request, the gate verifies that the same leaf still exposes the same file and captures the complete unsaved editor text.
3. The prompt builder combines that snapshot, the in-memory conversation, the user's request, and a budget-aware completion contract.
4. The view request coordinator estimates a conservative request budget from the selected model catalog (64,000-token fallback for DeepSeek; 256,000-token cap for Kimi K2.6) and blocks over-budget payloads before network access. The selected provider adapter sends a non-streaming HTTPS request through Obsidian `requestUrl`. Both adapters explicitly disable thinking and enforce a 120-second local timeout; only DeepSeek uses the configured temperature. Kimi supports only `/models`-verified `kimi-k2.6`. The timeout only stops local waiting/acceptance of late results; it does not cancel remote processing.
5. Conversation messages are parsed by the plugin's isolated Markdown renderer; original Markdown/LaTeX remains unchanged in storage and Copy actions. It does not invoke Obsidian or third-party post-processors, accepts no raw HTML, and never auto-loads images or Obsidian embeds. A bounded, untrusted KaTeX renderer handles dollar/bracket math delimiters with per-formula macros; invalid TeX degrades to escaped text. Scoped math CSS and WOFF2 fonts are bundled into `main.js` at build time. A `length` response is stored as raw partial content plus separate incomplete metadata and can be continued manually against the same note hash.
6. Edit responses are treated as untrusted JSON and must pass local validation. Non-`stop` and `needs_segmentation` responses never become proposals; the user may start one bounded full regeneration with a higher output budget.

## Edit transaction

An edit proposal contains only `oldText`, `newText`, an ID, and a reason. It cannot specify file paths, offsets, commands, or tool calls.

Before Apply, the plugin verifies:

- supported schema version and `complete` status;
- no uncovered targets;
- operation and field limits;
- every `oldText` anchor exists exactly once;
- edit ranges do not overlap;
- total change ratio stays within the configured budget;
- the same leaf, file object, path, and complete text snapshot are still active.

Selected edits are compiled locally and applied in one Obsidian editor transaction. Revert is offered only while the live text exactly equals the known post-apply result.

Apply and Revert have two side effects: the editor transaction and persistence of the updated history. They report editor success separately from a history-save failure. History writes are serialized by revision, and an explicit **Retry save** action is available while a save remains pending. Editor-change events update stale/revert state without re-rendering the whole conversation; rendered Markdown HTML is cached so scroll position is preserved.

Answer provenance is separate from message content. `completeRequest` freezes the model and requested reasoning from that invocation's options before the adapter is awaited; every AI reply creation path persists that snapshot with its existing local `createdAt`. Rendering uses only this stored data (model/Reasoning above, timestamp below), never current selector/profile state. Auto is a requested server default, not evidence of an actual effort; absent legacy fields remain unknown. Local Apply/Revert notifications have `origin: local` and no AI model attribution. Copy actions and provider-history construction still use only unchanged message content. Complex UI changes should include a bounded Kimi UI review; any K3 invocation must explicitly select K3-256k and send only task-scoped UI context.

## Secrets and persistence

- Each stable-ID profile has its own API key reference, connection test, model catalog, revision, and destination-specific consent. API keys live in Obsidian SecretStorage; plugin `data.json` stores only secret identifiers.
- Discussion and edit requests freeze `{profileId, profileRevision, providerId, modelId}`. Continue and edit retry reuse that target and fail closed if it changed; they never read the current selector as fallback.
- Profiles use a code-owned DeepSeek/Kimi adapter registry with reviewed HTTPS destination presets. Kimi profiles explicitly choose China or International; arbitrary base URLs, automatic cross-region key retries, and user-defined headers are not accepted.
- Legacy settings migrate to deterministic DeepSeek/Kimi profiles. Legacy shadow fields and a one-time `data.v0.1.6.rollback.json` snapshot preserve the pre-upgrade rollback boundary.
- `data.json` also stores non-secret settings and up to 50 locally named conversations, with at most 200 persisted user/assistant messages per conversation.
- Persisted history is bounded to 5 MiB per conversation and 20 MiB overall; individual conversations or all history can be deleted. Note rename updates the bound path and associated history.
- All settings fields are sanitized on load. Request-size budgeting is a conservative heuristic, not an official tokenizer count.
- Conversation history may contain private note-derived material and should be protected like the Vault itself.
- Pending proposals and revert snapshots remain memory-only.
- Edit-retry state remains memory-only. Finish reason, note hash, completion state, and numeric usage may be stored with local conversation messages; raw reasoning content is never stored.

## Network boundary

### Subscription transports

Kimi Code uses the official local CLI with an isolated tool-free agent, explicit K3-256k, private temporary input, blocked global automation, cancellation, and per-run journal verification. It retains its own session logs independently of plugin History.

ChatGPT plan usage uses official SIWC dynamic OAuth registration for OSS/local apps, not Codex auth or webpage automation. A machine-local host identity is stable across restarts; each profile references a separate validated registration. Tokens live outside the vault in protected files and refreshes are serialized. Sign-out retains registration metadata but clears tokens and attempts remote revocation. Opening a browser for consent is always a manual user action.

Its transport uses native desktop HTTPS `/v1/models` and `/v1/responses`, without redirects, provider fallback, tools, or inference retries. Each request sends complete required context with `store:false` and `stream:true`; system prompts become `instructions`. The SIWC preview rejects hard output limits, so prompt length targets are soft. The JSON-encoded request is admitted against a conservative 32k budget. SSE parsing requires an explicit successful terminal event before edits can be reviewed; raw reasoning remains undisplayed and unpersisted. Model/effort/service-tier choices are frozen into the request, and the returned service tier is separately reported when available. A 180-second deadline or Cancel destroys the local HTTPS request but cannot undo remote quota consumption.

Account/region/policy eligibility, app-specific limits, shared subscription usage, and optional credits remain controlled by OpenAI. Unsupported manual settings fail explicitly instead of falling back to API billing or another tier.

Opening the view, selecting a cached model, opening History, loading a conversation, or applying a validated proposal does not contact a provider. `/models` refresh sends that provider's credentials but no note content. Send and Propose changes transmit the complete current Markdown snapshot and relevant conversation messages after provider-specific consent.

The plugin has no telemetry, background provider calls, automatic retries, model-callable tools, or access to linked notes, embeds, attachments, Dataview results, PDFs, Canvas files, or the wider Vault. Continue and edit regeneration are always explicit user actions and create new paid provider requests.
