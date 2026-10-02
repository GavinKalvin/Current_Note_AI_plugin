# Security and privacy notes

Current Note AI intentionally has no model-callable tools, filesystem commands, vault search, background writes, telemetry, or automatic retries.

## Secret handling

- API profiles store only an Obsidian SecretStorage identifier in plugin settings. Kimi Code credentials remain in the official CLI.
- ChatGPT profiles use separate official SIWC OAuth registration and store only an opaque account UUID in vault settings. Access/refresh/ID tokens stay in machine-local owner-only `~/.config/current-note-ai/chatgpt/` files, not the vault, repository, browser storage, or another app's auth store. These files are not keychain-encrypted and cannot protect against privileged local code.
- ChatGPT sign-in checks PKCE, one-time state, signed OIDC identity/issuer/audience/expiry/nonce, returning identity, and plan-use scopes. The loopback listener binds `127.0.0.1` and expires or is cancelled with the sign-in modal. Credential rotation uses atomic replacement, an in-process queue, and a cross-process directory lock.
- ChatGPT HTTPS endpoints are fixed to official OpenAI origins, redirects are not followed, and no credentials/raw provider errors are logged. The Responses request exposes no tools; tool-bearing, interrupted, unknown, or incomplete edit responses are rejected.
- ChatGPT plan use may consume extra credits if the user enables that in ChatGPT usage settings. No API-key fallback or purchase is performed. Preview output limits are soft prompt targets, not server-enforced caps.
- Each account profile stores a separate SecretStorage reference. Its API key is resolved only for that request and injected into the selected code-owned DeepSeek or Kimi regional HTTPS adapter.
- Settings cannot supply a base URL, redirect target, arbitrary header, or request template. Custom OpenAI-compatible endpoints are intentionally unsupported.
- Consent and model catalogs are profile-scoped. Credential, enabled-state, or Kimi API-region changes invalidate the profile revision, catalog, selection, and consent. Keys are never silently retried against another region.
- Request bodies, note text, responses, and secrets are not logged by the plugin.
- SecretStorage reduces accidental plaintext persistence but does not protect against a malicious local process or another privileged plugin.

## Document writes

- Provider output is untrusted.
- Edit JSON is schema-checked and semantically validated against an immutable note snapshot.
- Every anchor must match exactly once, and operations must not overlap.
- The user must preview and explicitly apply selected changes.
- The bound editor, file object, path, and complete source text are checked again immediately before the Editor transaction.
- Revert is available only while the live note still exactly equals the post-apply text.

## Assistant reply rendering

- Provider-authored Markdown is parsed by a bundled, isolated renderer rather than Obsidian's global Markdown processing pipeline.
- Raw HTML is escaped and executable link protocols are rejected.
- Markdown images and Obsidian embeds are displayed as inert text and never auto-load remote or Vault content.
- Fenced code is displayed as escaped code and cannot invoke third-party code-block processors.
- User messages use the same isolated renderer; copying always uses the unchanged stored Markdown/LaTeX rather than rendered DOM text.
- Formula rendering uses bundled KaTeX with `trust: false`, strict HTML-extension validation, a 16,384-character formula limit, 256 formulas / 65,536 TeX characters per message, bounded macro expansion/dimensions and independent macros. Chinese formula text is allowed. Unsupported/over-budget formulas are escaped as text; formula commands cannot create remote images, active links or arbitrary HTML/CSS. Math styles and fonts are scoped/offline, with no CDN requests.

## Reporting

Do not include API keys or private note content in bug reports. Report a security issue privately to the maintainer before public disclosure.
