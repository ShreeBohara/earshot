# ADR-0006: Better Auth

## Status

Accepted (2026-11-15)

## Context and problem

Earshot needs sign-in with strong options (passkeys, MFA), and it must be self-hostable. A hosted identity service would make self-hosting depend on a third party, and its free tier may withhold the features Earshot wants.

## Considered options

- **Better Auth.**
- Clerk, which is hosted, and whose free tier excludes MFA and passkeys.

## Decision

Use Better Auth, an open-source library that runs inside the app. It supports passkeys and MFA at no cost and can be self-hosted. The plan calls for magic links, passkeys, and GitHub and Google sign-in in Phase 2, along with data export and account deletion. The `users` and `workspaces` tables hold the identities, with one workspace per user to start.

## Consequences

**Good**

- No hosted identity vendor, and no per-user fee.
- Self-hosters get the same auth as the hosted app.
- Auth costs $0 in the hosting plan.

**Bad**

- Earshot owns more of the auth surface, including session handling and its security review.
- Phase 9 needs to check whether Better Auth can act as the OAuth server for the MCP server, which uses OAuth 2.1.
- The earlier plan named Clerk, so that choice is replaced.

## More information

No auth ships in Phase 1. Auth checks will live in the data layer, not in `proxy.ts`, because OpenNext's support for `proxy.ts` is still experimental (ADR-0010).
