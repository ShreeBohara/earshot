# Threat model (v1)

Version 1 covers everything up to the end of Phase 2:

- the repository and its pipeline, from v0;
- user accounts and sign-in;
- tenant data in Postgres;
- the session event log;
- AI key handling;
- data export and deletion.

Phase 3 adds voice capture and model calls, and Phase 6 adds CRM adapters. Each phase updates this document. Phase 10 replaces it with a full STRIDE model.

## Scope

**In scope**

- The source repository and its contributors, including forks.
- Dependency installation (`pnpm install`).
- GitHub Actions workflows and the secrets they use.
- Cloudflare Workers (`earshot-web`, `earshot-edge`, and their per-PR copies).
- Neon Postgres branches and the schema in `packages/db`.
- Sign-in with Better Auth: magic links, passkeys, and GitHub and Google (ADR-0006).
- Tenant isolation by row-level security (ADR-0019).
- The session event store and its projections (ADR-0020).
- AI provider keys: stored on the device by default, sent per request, and kept in an optional server vault (ADR-0009, ADR-0021).
- Account export and deletion.

**Out of scope for v1**

- Voice capture, speech providers, and model calls. These start in Phase 3, so no AI key is used for anything but validation yet.
- CRM credentials and adapters. These start in Phase 6. The vault already encrypts CRM connections the same way as AI keys, but nothing writes them yet.

## Assets

| Asset | Where it lives |
|---|---|
| User identities and sign-in sessions | Better Auth tables (`user`, `session`, `account`, `passkey`, `verification`) |
| Tenant data: sessions, session events, utterances, proposals, CRM mirror, audit log | The 13 tenant tables, under row-level security |
| AI provider keys, on the device | IndexedDB, encrypted with a non-extractable WebCrypto key |
| AI provider keys, in the vault | `credentials`, envelope-encrypted: AES-256-GCM per secret, with its data key wrapped by the master key |
| The vault master key (`EARSHOT_VAULT_MASTER_KEY`) | A Worker secret only |
| `BETTER_AUTH_SECRET`, the Resend API key, OAuth client secrets | Worker secrets, and GitHub environment secrets for deploys |
| Magic-link tokens | Only a hash is stored, and a token is valid for 5 minutes |
| The Cloudflare token, the Neon credentials, and other CI secrets | GitHub environment secrets |
| The integrity of the repository and its release artifacts | GitHub |

## Trust boundaries

- **Contributor to repository.** Pull requests from forks are untrusted. Branches in this repository are trusted more.
- **Repository to CI.** Workflows run code from pull requests, so secrets are scoped to GitHub environments (`preview`, `production`) and reach only PRs from branches in this repository.
- **CI to Cloudflare and Neon.** Tokens are scoped, and deploys use environment secrets.
- **Browser to the web Worker.** Requests are authenticated by Better Auth's session cookie. Every page, server action, and route checks the session in the data layer. `proxy.ts` only redirects requests that have no cookie, as an optimization.
- **Owner connection to the tenant role.** The app connects to Postgres as the table owner, which bypasses row-level security. That connection is used only for work that has to span workspaces:
  - auth;
  - resolving a user's workspace and bootstrapping one;
  - account deletion;
  - key rotation.

  Everything else runs inside `withTenant`, which switches to the `earshot_app` role and pins one workspace and user for the transaction.
- **Workspace to workspace.** Row-level security keys every tenant row to `app.workspace_id`.
- **Device to server, for AI keys.** A key leaves the device only in the `x-earshot-provider-key` header of a single request, over TLS. The server writes it down only if the user puts it in the vault.
- **Worker to third parties.** These include:
  - AI providers' key-validation endpoints;
  - Resend, for magic-link email;
  - GitHub and Google, for OAuth.
- **Public internet to Workers.** Preview and production URLs on workers.dev are public.
- **Third-party packages and Actions to the build.** Code from outside the repository runs during install and CI.

## Threats and mitigations

### Pipeline (from v0)

| Threat | Where | Mitigation now |
|---|---|---|
| A malicious dependency or install script | `pnpm install` | 3-day cool-off, trust policy, approved install scripts, lockfile |
| A compromised third-party Action | Workflows | SHA pins, least-privilege `permissions:`, no persisted credentials |
| A fork PR stealing secrets | The preview workflow | `pull_request` only, the "branch in this repo" condition, environment-scoped secrets |
| Real data in previews | Neon | Previews fork from the seed-only `dev` branch, expire, and get torn down |
| Credentials leaked into git | The repo | Push protection; `.env*` and `.dev.vars*` are ignored |
| Someone deploying to your account | The Cloudflare token | Limited to Workers on one account, stored in environment secrets, rotated quarterly |
| A merged migration being edited after it ran | `packages/db/migrations` | A CI step fails any PR that modifies, renames, or deletes a merged migration |
| The development database reaching production | The Worker bundle | `build:worker` fails if PGlite is in the bundle |

### Accounts and sign-in

| Threat | Mitigation now |
|---|---|
| A stolen or intercepted magic link | Links work once and expire after 5 minutes. Only a hash of each token is stored, so a database leak reveals no working link. |
| Email bombing, or probing which addresses have accounts | Rate limits are stored in Postgres, so every isolate shares them. They key on `cf-connecting-ip`. On top of that, each address gets at most 5 links per 10 minutes, and a request over the cap still looks like success. |
| Brute force on the sign-in endpoints | Per-IP limits on magic-link verification, passkey authentication, and OAuth callbacks |
| Session cookie theft or CSRF | Better Auth's cookies are HttpOnly, SameSite=Lax, and Secure on https, and only trusted origins are accepted. The export route also refuses cross-site requests. |
| A stale session doing something drastic | Deleting the account, adding a passkey, and storing a key in the vault all need a sign-in from the last hour |
| An open redirect after sign-in | `?next=` is checked after normalization. It must be a single-slash path on our own origin with no backslashes or control characters. Tests cover about 440 generated variants. |
| Secrets or personal data in logs | Better Auth's log hook writes only the level and a redacted message. Our logger records errors by name and code, never by message, because driver errors quote query parameters. Email addresses are never logged. |
| A deployment with a weak or missing auth secret | Outside development, auth refuses to start without a long `BETTER_AUTH_SECRET` and an https base URL. In production it refuses to send magic links without an email provider, rather than printing them. |

### Tenant data

| Threat | Mitigation now |
|---|---|
| An app bug reading or writing another workspace's rows, such as a missing `where` or an id taken from a request | Row-level security covers all 13 tenant tables and fails closed: with no workspace set, nothing matches. Composite foreign keys `(workspace_id, x_id)` stop a row from referencing another workspace's row, because foreign-key checks bypass RLS. 290 pgTAP assertions run in CI, including catalog checks that fail when a table with a `workspace_id` lacks RLS or a grant reaches an unprotected table. |
| A member adding someone to their workspace, or promoting themselves | The app role can only read `workspace_members`. Membership is written by trusted code on the owner connection: the creator becomes owner at sign-up, and later invites will need the invitee to accept. |
| Writing a session or an audit entry in someone else's name | RESTRICTIVE policies require `sessions.user_id` (on insert, update, and delete) and `audit_log.actor_user_id` (on insert) to equal `app.user_id`. Composite foreign keys tie both to a membership. |
| Rewriting history | The event log is append-only for the app role: no UPDATE or DELETE on `session_events`. The audit log is append-only too. Projections can always be rebuilt from the log, and the rebuild is deterministic. |
| Learning that another workspace's session exists | An append to a session outside the workspace fails before the insert, so no unique-key error can hint at the other workspace's events. The session lock includes the workspace, so another workspace can't contend for it. |
| An export leaking secrets | The export leaves out tokens, password hashes, and envelope-encrypted material. Credentials appear as provider, label, last 4 characters, and timestamps. Tests seed known secrets and scan the export for them. |
| Incomplete deletion | Account deletion first removes every workspace where the user is the only member, which cascades all of its tenant data. Then it deletes the user, which cascades sessions, sign-in methods, and memberships. Tests check that another user's data survives. |

### AI keys

| Threat | Mitigation now |
|---|---|
| The server keeping keys it shouldn't | Keys stay on the device by default. The validation route has no database access. The vault is opt-in per key, and only exists when the deployment sets a master key; without one, storing is refused before the database is touched. Tests scan every table, every response, and every log line for the key. |
| A key showing up in a response or log | Keys travel only in a header, never in a URL or JSON body. The validation handler never forwards a provider's response body or headers, because some providers echo part of the key in their error text. Logs go through the redacting logger. |
| Using the validation route as an oracle for stolen keys | The route needs a sign-in and is rate-limited per user and per IP |
| Oversized requests exhausting memory | The validation body is capped at 1 KB. An oversized `Content-Length` is refused before reading, and streamed bodies are cut off at the cap. |
| A database leak exposing vault keys | Envelope encryption: AES-256-GCM with a fresh data key per secret, and the data key wrapped by a master key that lives only in a Worker secret. Ciphertexts are bound to their workspace and slot, so a row moved elsewhere won't decrypt. Listing never selects encrypted columns. |
| The master key leaking | Rotation re-wraps every data key in one transaction. It's strict: if any row fails to unwrap, nothing changes. The runbook is in `docs/vault-key-rotation.md`. The script prints counts only, and redacts errors before shortening them. |
| Vault functions run on the owner connection, where RLS doesn't apply | They refuse to run unless the transaction is in the `earshot_app` role with a workspace and user set |

## Known gaps

- **Row-level security isn't a sandbox.** It catches app bugs, but code holding the connection, such as a successful SQL injection, could `RESET ROLE` or change `app.workspace_id`. The mitigation is that every query goes through Drizzle with parameters.
- **Inside a workspace, child tables trust every member.** `session_events`, `utterances`, `proposals`, and `sync_jobs` aren't bound to their session's user. Phase 2 has one member per workspace. Team workspaces will need per-member rules, decided when manager review is designed (ADR-0019).
- **XSS could use device keys.** An XSS on Earshot's origin could ask the browser to decrypt them, even though the wrapping key can't be exported. There is no Content-Security-Policy yet; it's planned for Phase 10. Until then, keep dependencies few and render all text as text.
- **Rate limits key on IP**, so users behind one shared IP share a budget.
- **Nothing has run on real Neon or Cloudflare yet.** Unverified so far:
  - the role grant;
  - the pooled connection per request;
  - the database rate limiter and the presence of `cf-connecting-ip`;
  - email delivery;
  - passkeys on real devices;
  - OAuth callbacks.
- **The public workers.dev URLs** have no paid APIs behind them. Validation calls only providers' free key-check endpoints, using the user's own key.

## What Phase 10 adds

Phase 10 replaces this document with a full threat model: STRIDE across the whole system, plus the OWASP Top 10 for LLM applications. It also adds:

- CSP headers;
- dependency and secret scanning;
- a key-rotation drill;
- retention flows;
- a privacy policy;
- EU AI Act notices.
