# Contributing

Thanks for your interest in improving the SMSCode SDKs.

## Development (TypeScript SDK)

```bash
cd packages/sdk-js
bun install
bun run gen:types     # regenerate types from the OpenAPI contract
bun run build         # tsup build (ESM + CJS + .d.ts)
bun run test          # vitest
bun run lint          # eslint
```

## Pull requests

- Branch from `main`; open pull requests against `main`.
- Keep changes focused; add tests for new behavior.
- CI (build, type-check, test, lint, pack) must pass.

## Reporting bugs

Open an issue with a minimal reproduction. For security issues, see [SECURITY.md](SECURITY.md) — do not open a public issue.
