# Threat model (v0)

This is the first threat model. It covers only what exists in Phase 1: the repository, the build and deploy pipeline, and the skeleton deployments. Later phases add the product's runtime surfaces.

## Scope

**In scope**

- The source repository and its contributors, including forks.
- Dependency installation (`pnpm install`).
- GitHub Actions workflows and the secrets they use.
- Cloudflare Workers (`earshot-web`, `earshot-edge`, and their per-PR copies).
- Neon Postgres branches.

**Out of scope for v0**

- Voice capture, speech providers, and model calls. Phase 1 makes no model calls.
- User accounts, auth, and tenant isolation. These start in Phase 2.
- CRM credentials and adapters. These start in Phase 6.

## Assets

- The Cloudflare API token and account.
- The Neon API key and database credentials.
- Other CI secrets, such as the Chromatic and release-please tokens.
- The integrity of the repository and its release artifacts.
- Production data. In Phase 1 this is only the skeleton's `app_meta` table.

## Trust boundaries

- **Contributor to repository.** Pull requests from forks are untrusted. Branches in this repository are trusted more.
- **Repository to CI.** Workflows run code from pull requests, so secrets are scoped to GitHub environments (`preview`, `production`) and reach only PRs from branches in this repository.
- **CI to Cloudflare and Neon.** Tokens are scoped, and deploys use environment secrets.
- **Public internet to Workers.** Preview and production URLs on workers.dev are public.
- **Third-party packages and Actions to the build.** Code from outside the repository runs during install and CI.

## Threats and mitigations

| Threat | Where | Mitigation now |
|---|---|---|
| A malicious dependency or install script | `pnpm install` | 3-day cool-off, trust policy, approved install scripts, lockfile |
| A compromised third-party Action | Workflows | SHA pins, least-privilege `permissions:`, no persisted credentials |
| A fork PR stealing secrets | The preview workflow | `pull_request` only, the "branch in this repo" condition, environment-scoped secrets |
| Real data in previews | Neon | Previews fork from the seed-only `dev` branch, expire, and get torn down |
| Credentials leaked into git | The repo | Push protection; `.env*` and `.dev.vars*` are ignored |
| Someone deploying to your account | The Cloudflare token | Limited to Workers on one account, stored in environment secrets, rotated quarterly |
| Cost abuse of public preview URLs | workers.dev | No paid APIs behind them in Phase 1; rate limits arrive with token minting in Phase 3 |

## Known gaps

- The model covers the pipeline and skeleton only, not the product.
- Nothing in Phase 1 protects against abuse of the public workers.dev URLs beyond having no paid APIs behind them.

## What Phase 10 adds

Phase 10 replaces this document with a full threat model: STRIDE across the whole system, plus the OWASP Top 10 for LLM applications. It also adds CSP headers, rate limits, dependency and secret scanning, a key-rotation drill, retention and erasure flows, a privacy policy, and EU AI Act notices.
