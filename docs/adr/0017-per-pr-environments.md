# ADR-0017: Per-PR environments: separate Workers plus a Neon branch from a seed-only parent, with expiry and a janitor

## Status

Accepted (2026-11-15)

## Context and problem

Reviewers need to see a change running, with the web app, the edge Worker, and a database. Cloudflare doesn't generate version preview URLs for Workers that define Durable Objects. Its newer Worker Previews send service bindings to the production target, so a preview web app would talk to the production edge.

## Considered options

- **Separate Workers per PR, deployed under their own names, plus a Neon branch.**
- Cloudflare version preview URLs.
- Worker Previews.
- Preview databases forked from `production`, which risks real data in previews.

## Decision

Each PR from a branch in this repository gets two Workers, `earshot-web-pr-N` and `earshot-edge-pr-N`, and a Neon branch `preview/pr-N` forked from `dev`. `dev` holds seed data only and never expires. A script renders per-PR wrangler configs, and the edge deploys first because the web Worker binds to it. A Playwright smoke test runs against the preview, and a sticky PR comment lists the URLs.

Closing the PR deletes the web Worker, then the edge Worker, then the Neon branch. Neon branches expire after 14 days, and a daily janitor deletes leftovers whose PRs are closed.

PRs from forks get CI but no preview, because they never see environment secrets. The preview workflow uses `pull_request`, never `pull_request_target`.

## Consequences

**Good**

- A real full stack per PR, with no real data and no cross-talk with production.
- Cleanup has three layers: close, janitor, expiry.

**Bad**

- Each open PR uses two of the free plan's 100 Workers and one of Neon's 10 branches. Production, `dev`, and a personal branch take three, leaving seven for previews.
- `wrangler delete --force` is undocumented, so teardown can break.
- Previews are on workers.dev URLs until a custom domain exists.

## More information

See CONTRIBUTING.md for how previews work.
