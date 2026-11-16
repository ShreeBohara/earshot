# ADR-0006: Better Auth

## Status

Accepted (2026-11-15). Implemented in Phase 2 (2026-11-16); see "Implementation" below.

## Context and problem

Earshot needs sign-in with strong options (passkeys, MFA), and it must be self-hostable. A hosted identity service would make self-hosting depend on a third party, and its free tier may withhold the features Earshot wants.

## Considered options

- **Better Auth.**
- Clerk, which is hosted, and whose free tier excludes MFA and passkeys.

## Decision

Use Better Auth, an open-source library that runs inside the app. It supports passkeys and MFA at no cost and can be self-hosted. The plan calls for magic links, passkeys, and GitHub and Google sign-in in Phase 2, along with data export and account deletion. The `users` and `workspaces` tables hold the identities, with one workspace per user to start.

## Implementation

Phase 2 ships it in `apps/web/lib/auth/`. `server.ts` builds the instance from explicit dependencies, so tests build their own against PGlite; `index.ts` builds the app's, once per isolate.

**The library.** `better-auth` 1.7.22 and `@better-auth/passkey` 1.7.22 from the pnpm catalog, held at 1.7.x because packages/db's auth tables came from the 1.7.22 CLI. 1.7.22 is also the newest release the 3-day `minimumReleaseAge` allowed when this was built. The app imports `better-auth/minimal` (no Kysely in the Worker) with the Drizzle adapter on the existing schema, `transaction: true`, so multi-step writes such as an OAuth user and their account are atomic. The adapter checks the Drizzle schema against Better Auth's expectations at run time, and the tests exercise that check.

**Sign-in methods.** There are no passwords: `emailAndPassword` is off.

- *Magic links.* Single use, valid for 5 minutes. Only a hash of each token is stored (`storeToken: "hashed"`), so a database leak reveals no working link. New users land on `/onboarding` through `newUserCallbackURL`; no column records onboarding.
- *Passkeys.* The relying party is pinned to `BETTER_AUTH_URL`: its host is the `rpID` and its origin the only accepted origin. Passkeys sign existing users in; adding one happens in Settings.
- *GitHub and Google.* A provider is configured only when both its client id and its secret are set. The server decides which buttons the sign-in page shows (`socialProviderIds`), and an unconfigured provider answers 404.

**Email.** With `RESEND_API_KEY` and `EMAIL_FROM` set, links go out through Resend's HTTP API with `fetch`; there's no SDK. Without them:

- In development (`next dev`), the link is printed to the terminal, marked development-only. The email address isn't printed.
- In every built bundle, previews included, sending fails closed. The request answers 503 with `EMAIL_UNAVAILABLE`, the server logs that the variables are missing, and the link is written nowhere.

Provider errors report only the HTTP status, and response bodies are discarded, since they can echo the recipient.

**Configuration** (`config.ts`, documented in `apps/web/env.d.ts` and `.dev.vars.example`). Outside development, `BETTER_AUTH_SECRET` (at least 32 characters) and `BETTER_AUTH_URL` (https, or localhost for `pnpm preview`) are required. If either is missing, every auth path throws instead of falling back. Trusted origins are the base URL's origin plus `BETTER_AUTH_TRUSTED_ORIGINS`. Cookies are named `earshot.*` and are `Secure` over https. Logs never carry request data. Every line goes through the redacting logger, which strips the auth secret, OAuth client secrets, the Resend key, the database URL, and anything shaped like a provider key, and errors are logged by name and code only, never by message (a database error's message can quote its query parameters). Better Auth's own lines keep just their level and a scrubbed message, with email addresses and long random tokens masked; of the arguments Better Auth passes along, only an `Error`'s name and code survive. Telemetry is off.

**Rate limiting.** In-memory counters don't work on Workers: each isolate would keep its own. Better Auth's database storage keeps them in `rate_limit` (migration 0011). Like Better Auth's other tables, that table has no row-level security and no grant to `earshot_app`, and pgTAP checks both (`80_rate_limit.sql`). Limits are per client IP, read from `cf-connecting-ip`, which Cloudflare sets and clients can't forge (unlike `X-Forwarded-For`):

| Path | Limit |
|---|---|
| `/sign-in/magic-link` | 5 per 10 minutes |
| `/magic-link/verify` | 10 per minute |
| `/sign-in/social` | 10 per minute |
| `/callback/*` | 20 per minute |
| `/passkey/generate-authenticate-options` | 20 per minute |
| `/passkey/verify-authentication` | 10 per minute |
| `/delete-user` | 5 per 10 minutes |
| `/get-session` | unlimited |
| everything else | 100 per minute |

`/get-session` is read-only and frequent, so limiting it would cost a query per call for nothing. Separately, each address gets at most 5 magic links per 10 minutes, whatever the IP, so nobody can flood a victim's inbox from many addresses. That cap keys on an HMAC of the address, keyed with the auth secret, in the same table: `rate_limit` never holds an email, and can't be checked against a list of them. Over the cap, the request still answers success, so it reveals nothing about the address's history. Limiting is on in production and off under `next dev`.

**Sessions.** They use Better Auth's defaults: 7 days, extended daily while in use, with no cookie cache, so every request checks the session in Postgres. A sign-in counts as fresh for an hour. Deleting the account and adding a passkey need a fresh sign-in, and `/sign-in?reauth=1` gets one without signing out first.

**Workspace bootstrap.** Better Auth's `user.create.after` hook calls `ensureWorkspace` (packages/db). On the owner connection, that function creates a personal workspace and the owner membership in one transaction. A transaction-scoped advisory lock on the user id makes it idempotent under races. If the hook fails, sign-in still succeeds, and the next `getViewer` calls `ensureWorkspace` and repairs it.

**Checks in the data layer** (`viewer.ts`). Every page, server action, and route that touches user or tenant data starts with one of these:

- `getViewer()` validates the session against Postgres, resolves the workspace with `resolveWorkspace` (ADR-0019), and returns `{ user, session, workspaceId, workspaceName, role }` or null. It's memoized per render, and costs nothing for visitors with no session cookie.
- `requireViewer(next)` redirects pages and server actions to `/sign-in?next=…`.
- `withViewer(handler)` makes route handlers answer 401 with JSON instead.
- `withViewerTenant(fn)` runs `withTenant` as the viewer.

`?next=` only accepts same-site paths, so it can't become an open redirect. The path is checked again after normalizing, because dot segments can turn a single-slash path into a protocol-relative one (`/.//evil.example` normalizes to `//evil.example`). `proxy.ts` only redirects requests without a session cookie away from `/home`, `/onboarding`, and `/settings`; it never vouches for a cookie. Next 16 runs `proxy.ts` on the Node.js runtime, which OpenNext supports only experimentally (ADR-0010). `build:worker` bundles it, and a local workerd preview redirected correctly. The checks don't depend on it.

**Export and deletion.**

- `GET /api/account/export` returns one JSON download. It holds the profile and sign-in records, read as the owner and filtered by user id, plus every tenant table's rows for each of the user's workspaces, read through `withTenant`. Secrets stay out:
  - OAuth tokens, password hashes, and session tokens;
  - passkey public keys;
  - the encrypted columns of `credentials` (only provider, label, last 4, and timestamps go out) and `crm_connections`.

  Each export writes an `account.exported` audit entry in the same transaction as its reads.
- Deletion is Better Auth's `/delete-user`, which requires a fresh session. Its `beforeDelete` hook first deletes every workspace where the user is the only member, which cascades their tenant data. Deleting the user then cascades their sessions, accounts, passkeys, and memberships. The UI asks the user to type their email to confirm.

**Tests** (`apps/web/test`, against Better Auth's real handler on PGlite) cover:

- sign-up creating exactly one workspace, and reuse on the next sign-in;
- hashed, single-use tokens;
- repair after a failed hook, and `ensureWorkspace` idempotence;
- `loadViewer`, the core of `getViewer`;
- provider gating;
- email that fails closed without logging, Resend delivery, and the development console;
- rate limits shared across instances, plus the per-address cap;
- the export route's 401, its refusal of cross-site requests, and the download;
- `?next=` sanitizing, including paths that only become another host once normalized;
- log scrubbing: tokens, emails, and provider keys passed to Better Auth's logger never reach a log line;
- export isolation, with seeded secret canaries scanned for in the JSON;
- deletion, including a stale session and no session;
- proxy redirects.

Playwright checks `/sign-in` and `/demo` with axe, in light and dark.

## Consequences

**Good**

- No hosted identity vendor, and no per-user fee.
- Self-hosters get the same auth as the hosted app.
- Auth costs $0 in the hosting plan.

**Bad**

- Earshot owns more of the auth surface, including session handling and its security review.
- Phase 9 needs to check whether Better Auth can act as the OAuth server for the MCP server, which uses OAuth 2.1.
- The earlier plan named Clerk, so that choice is replaced.
- Without a cookie cache, rate-limited endpoints cost two or three extra queries for the limiter, and every signed-in page costs a session lookup. A short cookie cache would save queries, but a revoked session would stay usable until the cache expired.
- Email sign-in needs an email provider in every deployment, previews included. Without one, only passkeys work, and only for users who already have an account.
- Server components can't set cookies, so a session extended during a page render keeps its cookie's original expiry until an auth request or server action refreshes it. Expect a re-sign-in about a week after signing in.

## More information

Auth checks live in the data layer; `proxy.ts` only makes optimistic redirects, because OpenNext's support for it is experimental (ADR-0010). How the Worker reaches Postgres per request, and why Better Auth shares the WebSocket pool, is in ADR-0018. Local setup is in CONTRIBUTING.md.
