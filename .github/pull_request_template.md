## What and why

<!-- What changes, and the reason for it. Link the issue or roadmap phase. -->

## How it was checked

<!-- Commands you ran, tests you added, screenshots for UI changes. -->

## Checklist

- [ ] The PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, `chore:`, …). It becomes the squash commit.
- [ ] `pnpm check && pnpm typecheck && pnpm test` pass locally.
- [ ] Changed a contract in `packages/core`? I ran `pnpm contracts:gen` and committed the output.
- [ ] Changed the architecture? I added or updated an ADR in `docs/adr/`.
- [ ] Changed the database? The migration is expand-then-contract (no breaking change in one deploy).
- [ ] No secrets, keys, or personal data in code, fixtures, or logs.
