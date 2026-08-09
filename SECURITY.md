# Security and privacy notes

Current Note AI intentionally has no model-callable tools, filesystem commands, vault search, background writes, telemetry, or automatic retries.

## Secret handling

- The plugin stores only an Obsidian SecretStorage identifier in plugin settings.
- The API key is injected only into the HTTPS Authorization header for the configured DeepSeek endpoint.
- Request bodies, note text, responses, and secrets are not logged by the plugin.
- SecretStorage reduces accidental plaintext persistence but does not protect against a malicious local process or another privileged plugin.

## Document writes

- Provider output is untrusted.
- Edit JSON is schema-checked and semantically validated against an immutable note snapshot.
- Every anchor must match exactly once, and operations must not overlap.
- The user must preview and explicitly apply selected changes.
- The bound editor, file object, path, and complete source text are checked again immediately before the Editor transaction.
- Revert is available only while the live note still exactly equals the post-apply text.

## Reporting

Do not include API keys or private note content in bug reports. Report a security issue privately to the maintainer before public disclosure.
