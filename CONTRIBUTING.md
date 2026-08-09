# Contributing

Contributions are welcome through focused issues and pull requests.

## Development

Requirements: Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm check
pnpm build
```

`pnpm check` runs TypeScript validation and the Vitest suite. A behavior-changing pull request should include or update tests, preserve the current-note data boundary, and describe any new content sent to an external provider.

## Security-sensitive changes

Changes involving credentials, document writes, history persistence, provider requests, or edit validation require an explicit threat analysis. Do not include API keys, Vault data, private note content, or generated `data.json` files in commits or issues.

Please report vulnerabilities privately as described in `SECURITY.md` rather than opening a public issue with exploit details.
