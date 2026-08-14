# Architecture and trust boundaries

## Objective

Current Note AI lets a user discuss or revise exactly one explicitly bound Markdown note. The provider may propose text, but it cannot choose a file, execute a command, search the Vault, or write directly to the editor.

## Request path

1. `CurrentDocumentGate` binds a concrete Obsidian `WorkspaceLeaf`, `TFile`, and path.
2. Immediately before a request, the gate verifies that the same leaf still exposes the same file and captures the complete unsaved editor text.
3. The prompt builder combines that snapshot, the in-memory conversation, the user's request, and a budget-aware completion contract.
4. `DeepSeekAdapter` sends a non-streaming HTTPS request through Obsidian `requestUrl`, explicitly disables thinking, and parses numeric token usage including reasoning tokens when supplied.
5. Discussion responses are parsed by the plugin's isolated Markdown renderer. It does not invoke Obsidian or third-party post-processors, accepts no raw HTML, and never auto-loads images or Obsidian embeds. A `length` response is stored as raw partial content plus separate incomplete metadata and can be continued manually against the same note hash.
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

## Secrets and persistence

- The API key lives in Obsidian SecretStorage. Plugin `data.json` stores only the secret identifier.
- `data.json` also stores non-secret settings and up to 50 locally named conversations, with at most 200 persisted user/assistant messages per conversation.
- Conversation history may contain private note-derived material and should be protected like the Vault itself.
- Pending proposals and revert snapshots remain memory-only.
- Edit-retry state remains memory-only. Finish reason, note hash, completion state, and numeric usage may be stored with local conversation messages; raw reasoning content is never stored.

## Network boundary

Opening the view, selecting a cached model, opening History, loading a conversation, or applying a validated proposal does not contact DeepSeek. `/models` refresh sends credentials but no note content. Send and Propose changes transmit the complete current Markdown snapshot and relevant conversation messages after user consent.

The plugin has no telemetry, background provider calls, automatic retries, model-callable tools, or access to linked notes, embeds, attachments, Dataview results, PDFs, Canvas files, or the wider Vault. Continue and edit regeneration are always explicit user actions and create new paid provider requests.
