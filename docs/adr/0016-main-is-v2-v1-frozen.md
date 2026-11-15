# ADR-0016: `main` is v2; v1 is frozen on a tag and a branch

## Status

Accepted (2026-11-15)

## Context and problem

v2 is a rebuild. The plan first proposed a long-lived `v2` branch. But Renovate, CodeQL, release-please, rulesets, and the deploy workflows all assume the default branch, so a long-lived branch means configuring each of them twice, followed by a large merge. v1 also needs a clear, honest end point.

## Considered options

- **Freeze v1 on a tag and a `v1` branch; `main` becomes v2.**
- Build v2 on a long-lived `v2` branch.
- Start a new repository, which would lose the existing history and stars.

## Decision

v1 is frozen at tag `v1.0-hackathon` (commit `5b731bd`) and on branch `v1`. That commit includes PR #5, a Vitest regression harness for v1's tools and stores. A GitHub release with a 60-second video is planned. `main` becomes v2 in the same repository, keeping its history and stars.

Phase 1 clears the v1 files from `main`. Any unpushed 2.0 work should be pushed to `archive/v2-draft` before the restructure. The v1 demo is taken offline, since it ran on a key the maintainer paid for. `docs/v1-retrospective.md` records what v1 was and what it taught.

## Consequences

**Good**

- Tooling works on the default branch with no duplicate setup.
- v1 stays reproducible and honest, with a retrospective.
- No big branch merge later.

**Bad**

- `main` has no working app for a while, because v2 starts empty.
- Links and habits that assumed v1 on `main` break. Use the tag or the `v1` branch.
- Anyone who wants v1 must check out the tag.

## More information

See `docs/v1-retrospective.md`.
