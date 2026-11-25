# ADR-0021: Key handling: on-device storage, per-request use, an optional envelope-encrypted vault

## Status

Accepted (2026-11-15). This implements ADR-0009 in `packages/keys`, and the vault's storage in `packages/db`. The web app's routes and Settings → Keys followed in Phase 2 (2026-11-16); see "In the web app" below. Amended for Phase 4 (2026-11-20): the second witness uses the Groq key from the page; see "Amendment: Phase 4" below. Amended for Phase 5 (2026-11-25): a server-side signing key for the audit chain, on both Workers; the evidence clips' own key on the device; and the recap's key, a second slot on the socket. See "Amendment: Phase 5" below.

## Context and problem

Earshot is bring-your-own-key, and the hosted instance must never hold anyone's AI keys unless the user opts in. Keys still have to reach a provider somehow. A leak can happen through storage, but also through logs, error messages, and API responses.

## Considered options

- **Keys on the device, sent per request, plus an optional server vault (chosen).**
- Keys always stored on the server.
- Keys kept in browser storage in plain text.

## Decision

- **Device storage.** Keys are encrypted in IndexedDB with an AES-256-GCM key created as non-extractable, so JavaScript can use it but never read its bytes.
  - Each ciphertext is bound to its slot (provider and label) through GCM additional data, so a ciphertext moved into another slot doesn't decrypt.
  - Clearing the store also deletes the device key.
- **Per-request use.** A key is decrypted in memory and sent only with the request that needs it, in the `x-earshot-provider-key` header, over TLS. The server holds it in memory for that request or session, and never writes it down.
- **The vault**, which is optional for AI keys and always used for CRM credentials, uses envelope encryption:
  - Each secret gets its own random AES-256-GCM data key.
  - The data key is wrapped by a master key held as the Worker secret `EARSHOT_VAULT_MASTER_KEY`. The master key can only wrap and unwrap; it never encrypts data directly.
  - A context string (workspace, kind, name) is authenticated at both layers, so a sealed secret can't be moved to another row. A credential's context is its workspace and slot (provider and label). A CRM connection's is its workspace, provider, and row id, because a workspace can hold several connections to one CRM; whatever writes those rows generates the id before sealing.
  - Rotating the master key re-wraps the data keys and leaves every ciphertext unchanged. `db:rotate-vault-key` does it in one transaction, and [the runbook](../vault-key-rotation.md) gives the order of operations.
- **Vault on or off.** The vault is on exactly when the deployment sets `EARSHOT_VAULT_MASTER_KEY`. Otherwise `loadVaultMasterKey(env)` returns null, and callers must refuse to store or reveal vault secrets: `putCredential` and `revealCredential` throw `VaultOffError` when given null, before touching the database. A key that is set but malformed throws instead of turning the vault off. Even with the vault on, an AI key is stored only when its user saves it there.
- **Vault storage** (`packages/db/src/vault.ts`) runs only in a transaction from `withTenant`, and refuses any other, so RLS confines it to one workspace. It returns metadata (provider, label, last four characters, validated and created times), and listing never selects an envelope column. Only `revealCredential` returns plaintext, for server-side provider calls. Storing, replacing, and deleting a key each write an audit entry in the acting user's name, with the provider, label, and last four characters. A label can't hold anything shaped like a key, since labels are shown and audited in plain text.
- **Validation** is a cheap authenticated GET to each provider, behind `handleValidateKey(request, { fetch, logger })`, a fetch-style handler that any route can call. The key comes only from the `x-earshot-provider-key` header, never the body or the URL. The response is `{ ok, provider, last4, reason }`, with a fixed reason code and `cache-control: no-store`. It never forwards the provider's response body, headers, or messages, because some providers quote part of the key in their errors. The handler has no database access, so validating stores nothing. The UI only ever shows the last four characters.
- **Redaction.** Every server log line goes through a redacting logger. It removes known secrets and anything shaped like a provider key (`sk-…`, `sk-ant-…`, `gsk_…`, `AIza…`) or a short-lived credential (OpenAI's ephemeral `ek_…` keys and JWT-shaped strings, added in Phase 3 with ADR-0023). Keys with no fixed shape, such as Deepgram's and AssemblyAI's, are redacted exactly: a route hands its request's logger the key it carries. A canary key in the tests proves keys never reach logs, errors, or validation results.

## In the web app

Phase 2's last slice puts this to work in `apps/web`: two routes, the Settings → Keys page, and the demo CRM. The rule it has to prove is the plan's gate: no response or log ever contains a key, and the server never stores an AI key unless the vault is on.

### Routes

The logic is in `lib/keys/routes.ts`, built from explicit dependencies (the database, the environment, a logger, the provider `fetch`, a clock), so tests run it against PGlite. The route files wrap it in `withViewer` (ADR-0006), which answers 401 without a valid session. Every response is `cache-control: no-store`, and none quotes the request: answers hold fixed codes, the provider id, and at most a key's last four characters.

| Route | What it does |
|---|---|
| `POST /api/keys/validate` | Checks a key with its provider through `handleValidateKey`, with the app's redacting logger and a 10-second timeout. Stores nothing. |
| `GET /api/vault/credentials` | `{ vaultAvailable, credentials }`, metadata only: provider, label, last four, validated-at, created-at. |
| `PUT /api/vault/credentials` | Stores a key in the vault. The provider and label come from the JSON body and the key from `x-earshot-provider-key`, never the body or the URL. |
| `DELETE /api/vault/credentials` | Empties a slot, named by provider and label in the JSON body. Works while the vault is off, so keys stored earlier can always be removed. |

`PUT` runs its checks in this order:

1. The vault must be on. If `loadVaultMasterKey` returns null, the answer is 409 `vault_off`, before any database, rate-limit, or provider work.
2. The sign-in must be fresh, under an hour old, by the same rule as deleting the account (`lib/auth/fresh.ts`). If it isn't, the answer is 403 `reauth_required`, and the page links to `/sign-in?reauth=1`.
3. The body must name a supported provider and a valid label (400 `invalid_request`, `unknown_provider`, or `invalid_label`), and the header must carry the key (400 `missing_key`).
4. The rate limits must allow another check (429).
5. The provider must accept the key. If it doesn't, the answer is 422 with the provider's fixed reason code (`rejected`, `rate_limited`, `upstream_error`, `unreachable`), and nothing is stored.
6. Only then does `putCredential` seal and store it, with `validatedAt` set to now.

A label can't hold a key: neither the key being stored nor anything shaped like a provider key (`lib/keys/labels.ts`, matching the vault's own check). The browser applies the same rule before sending.

Cross-site requests are refused with 403 (`sec-fetch-site` of `cross-site` or `same-site`). The session cookie is already `SameSite=Lax`, and Earshot's pages call these routes from their own origin, so there's no legitimate cross-site caller.

### Rate limits

Checking a key with its provider is the expensive and abusable part: a signed-in account mustn't become an oracle for testing stolen keys. Validation and `PUT` (which validates first) share two counters in Better Auth's `rate_limit` table (`consumeRateLimit` in `lib/auth/throttle.ts`), so every Worker isolate sees the same counts:

| Counter | Key | Limit |
|---|---|---|
| Per user | `key-check\|user:<user id>` | 10 per 10 minutes |
| Per client IP | `key-check\|ip:<cf-connecting-ip>` | 30 per 10 minutes |

One upsert both counts and decides, so concurrent requests can't slip past. The window resets 10 minutes after the last check that was let through, as Better Auth's own limiter does; refused requests are counted but don't extend it. A refusal is 429 `too_many_requests` with `Retry-After` and `retryAfterSeconds`. The IP comes from `cf-connecting-ip`, which Cloudflare sets and clients can't forge; without it, as under `next dev`, only the per-user limit applies. The rows hold the user id and the address, never a key or an email, and Better Auth prunes them after its longest window, which is also 10 minutes. Like Better Auth's limits, these are on in production and off under `next dev`.

### Errors

| Error | Response |
|---|---|
| `VaultOffError` | 409 `vault_off` |
| `TypeError` (input the vault refused) | 400 `invalid_request` |
| `VaultOpenError` | 500 `server_error`, no detail |
| anything else | 500 `server_error`, no detail |
| `EARSHOT_VAULT_MASTER_KEY` set but malformed | 500 `server_error` from `GET` and `PUT` |

The log gets each error's name and code only (`errorSummary`), never its message. A malformed master key fails closed: it isn't treated as "off", so the vault can't quietly lose access to rows sealed with the intended key. The log line names the variable and never quotes it, and `secretValues` adds the key to what the logger redacts.

**Configuration.** `EARSHOT_VAULT_MASTER_KEY` is documented in `apps/web/env.d.ts` and `.dev.vars.example`. Deploys pass it to the Worker through the CI secrets file when the GitHub environment secret of the same name is set; without it the vault stays off. The `production` environment's value is production's key, and the `preview` environment's value is `dev`'s, because preview branches fork from `dev` with its sealed rows ([the runbook](../vault-key-rotation.md)).

### Settings → Keys

The page (`app/(app)/settings/keys`) has two sections:

- **On this device** comes first and is the default. It lists the `DeviceKeyStore` keys (provider, label, last four, when each last passed a check), and each can be checked again or removed after a confirmation. Adding one means picking a provider, naming it, and pasting the key. The page validates the key through `/api/keys/validate` and stores it on the device only if the provider accepts it. A paragraph explains that the key stays on this device and is sent only with the requests that need it, over TLS.
- **Stored on the server (vault)** appears only when the vault is on, or when keys stored earlier remain after it went off; those can still be removed. Storing is an explicit, per-key opt-in behind its own button, with a note on the trade-off: a stored key works on every device and for background work, but the server holds it. A key stored here goes to this device too only if the user ticks "Also keep a copy on this device". Storing needs a fresh sign-in; without one, the section offers a link to sign in again instead of the form.

Each key shows one status pill: checked, not checked, checking, or a problem. Every reason code maps to one sentence of copy in `lib/keys/reasons.ts`. Rejected keys show red; problems that retrying later should fix show amber.

The key itself is handled as little as possible:

- The key field is a plain, uncontrolled password input with autocomplete off. `@earshot/ui`'s `Input` is Base UI's field control, which keeps the value in React state for validation, so it isn't used for keys; the field shares its styles through `inputClassName`.
- The value is read once on submit, and the field is cleared before the request goes out.
- The key lives only in the submit handler's scope until the request settles. It never enters React state, and the list holds metadata only.
- The label field is uncontrolled too, and a label shaped like a key is cleared, in case one was pasted in the wrong place.

### The demo CRM

`loadDemoCrm(tx)` and `removeDemoCrm(tx)` in `packages/db` run inside `withTenant`, and refuse any other transaction. Loading inserts `toEntityRows()` (60 companies, 150 contacts, 40 deals) into `crm_entities`, with no connection and external ids prefixed `demo:` (`demo:co_001`). It's idempotent: `ON CONFLICT DO NOTHING` on the external-key unique constraint, which is `NULLS NOT DISTINCT`, so a second load, or one after a partial load, leaves exactly one copy of each row. Removing deletes rows with no connection and the `demo:` prefix, and only those, so rows from a real CRM or typed in by hand stay. Facts about removed rows go with them, and proposals that targeted one lose the target (the foreign keys' cascade and SET NULL). Each call writes `demo_crm.loaded` or `demo_crm.removed` to the audit log with its counts, but only when it changed something. The account export already includes `crm_entities`.

Onboarding offers it as a third way to start, alongside adding a key and the replay demo. Settings → Data shows how much is loaded and offers load and remove. Both go through server actions in `app/actions/demo-crm.ts`.

### Tests

- **Routes** (`apps/web/test/key-routes.test.ts`, Better Auth's real handler on PGlite):
  - Validation: 401 when signed out, 429 past each limit, and refusals for a key in the body or the URL and for cross-site requests.
  - Leaks: a fake provider quotes every key in its body and headers, and no eight characters of a key in a row reach a response, a log line, or a `console` call. One canary matches no provider-key pattern, so redaction can't hide a leak.
  - Validation writes nothing: every column of every table is dumped as the owner, and no row contains the key afterwards, while `credentials` is unchanged.
  - Vault off: `PUT` answers 409 before any other work, and the database holds the key nowhere, while list and delete still work.
  - Vault on: `PUT` stores the key, and list shows its last four only. A rejected key isn't stored, an old session gets the re-auth response, and B can't list or delete A's keys. The 64-character label limit matches the vault's.
  - The error mapping, and a malformed master key failing closed without being quoted.
  - The gate: a mix of validation calls and vault operations. With the vault off, the key appears nowhere. With it on, it appears only as ciphertext, which `revealCredential` opens.
- **The demo CRM** (`packages/db/test/demo-crm.test.ts`): load is idempotent and fills partial loads, remove deletes only demo rows, B sees nothing, and the audit entries.
- **The browser client and copy** (`apps/web/test/keys-client.test.ts`): the key goes only in the header, every answer maps to a problem code, and every code has copy.
- **Playwright** (`apps/web/e2e/keys.spec.ts`, also in CI's `ui` job): adds, checks, and removes a device key with `/api/keys/validate` stubbed, asserts the key went in the header and never reached the page, loads and removes the demo CRM, and runs axe in light and dark. It signs in for real: the zero-setup server prints each magic link, the test reads it from the server's log, and a nonce in the callback URL ties each link to its test.
- **Stories** for `KeyList` and `AddKeyForm` (`apps/web/components/keys/*.stories.tsx`): `@earshot/ui`'s Storybook now also loads the web app's stories, and runs axe on each, in light and dark.

## Consequences

**Good**

- The hosted instance stores no AI keys by default, which is a simple trust story to explain.
- A stolen database dump without the master key reveals nothing.
- The gate is a test that runs in CI: with the vault off no key reaches the database, a response, or the log, and with it on a stored key exists only as ciphertext.
- Rotating the master key is cheap.

**Bad**

- Keys are per device: a second device needs the key entered again, unless the user turns on the vault.
- Background jobs can't use a key that lives only on a device. Features that need one will require the vault.
- Clearing site data deletes the keys. That's by design, but it can surprise people.
- The Worker holds one master key at a time, so a rotation turns the vault off for a few minutes. Stored AI keys and CRM tokens are unavailable, though intact, until the new key is in place.
- The per-IP limit is shared by everyone behind one address, so a team behind an office NAT gets 30 key checks per 10 minutes between them. Each check also costs two upserts on `rate_limit`.
- Turning the vault on is a deploy-time decision: one secret per environment, and the runbook to change it. There's no per-workspace switch.
- The end-to-end test reads the magic link the dev server prints, so it needs zero-setup mode. A local `.dev.vars` file stops wrangler from passing the test's environment to the dev server.
- The web app's stories run in `@earshot/ui`'s Storybook, so `apps/web` carries Storybook as a dev dependency for their types.

## Amendment: Phase 4 (2026-11-20)

- **The Groq key, used from the page.** The second witness (ADR-0029) reads the rep's Groq key from the device and sends it from the page straight to `api.groq.com`, in an `Authorization` header, once per turn. On that path it never goes through Earshot. Groq has no short-lived credential to mint, so this is the one place a page uses an AI key itself (ADR-0002's Phase 4 amendment). If the rep also picks Groq for extraction, the same key rides on each `turn_end` to `SessionDO`, as since Phase 3.
- **On the device only.** The witness needs the key on the device. One kept only in the vault doesn't turn it on, and the capture screen doesn't offer it.
- **Tests.** `packages/voice/test/witness-groq.test.ts` holds that the key goes only to `api.groq.com`, only in `Authorization`, and into neither the URL, the request body, the result, nor a log. The session protocol refuses key-shaped strings outside `turn_end.key`, so a witness message can't carry one.

## Amendment: Phase 5 (2026-11-25)

- **The audit signing key, a Worker secret** (ADR-0033). `EARSHOT_AUDIT_SIGNING_KEY` is an Ed25519 private JWK with a key id, set on both Workers: the web Worker signs each review request's, policy change's, and export's checkpoint, and the edge Worker's flush consumer each flush that carries reviews. It's Earshot's key, not a user's: it signs the audit chain's head and nothing else, and it never leaves the Worker. `loadAuditSigningKey` imports it non-extractable, signs a probe to check its public half, and reports `configured`, `development`, `missing`, or `invalid` without ever throwing, logging, or returning the value; the redacting loggers scrub the value whole and its `d` alone. `pnpm --filter @earshot/keys audit-key:new` prints a new one and writes no file. Development signs with a committed key, refused outside development as the ticket secret's development value is. Outside development, without a usable key, writes that need a checkpoint fail closed: the review and policy routes answer 503 `audit_unavailable`, `SessionDO` refuses `review` and applies no policy, and the flush retries a message carrying reviews. `/api/health` says which state it's in, never the key.
- **Rotating it.** Make a new key, add the old one's public JWK to the public variable `EARSHOT_AUDIT_RETIRED_KEYS` with its `retiredAt`, and set the new secret on both Workers. `/api/audit/keys` serves the active public key and the retired ones; a retired key's signatures count only up to its `retiredAt`, and a retired entry holding a private key makes the route serve nothing. Unlike the vault's master key, rotating it re-encrypts nothing: old checkpoints stay verifiable by their own key ids.
- **The evidence key, on the device** (ADR-0036). Evidence clips are encrypted with AES-GCM under a 256-bit key of their own, generated non-extractable on the first clip kept and stored as a `CryptoKey` in their own IndexedDB database, `earshot-evidence`, apart from the device keys' database and key. Each clip is bound to where it's stored (`earshot-clip:v1:<sessionId>:<turnId>` as additional data), as each device key is bound to its slot. Clearing clips (sign-out, turning them off, another user opening the app) deletes the clips and this key and never touches the AI keys. It never leaves the device, and no server ever holds it.
- **The recap's key, a second slot.** The recap's LLM key rides on `end`, at `end.recap.key`, handled as `turn_end.key` is (ADR-0025, ADR-0037): held apart in the client's in-memory outbox and dropped on the ack, used for the one recap call, never stored or logged. The socket's key guard now allows a key-shaped string in exactly those two places and refuses it everywhere else, so the Phase 4 amendment's "outside `turn_end.key`" reads "outside `turn_end.key` and `end.recap.key`". Canary tests scan `SessionDO`'s SQLite, the Queue messages, socket frames, and logs for it (`apps/edge/test/sessions/recap.test.ts`, "the recap's key").
- **Tests.** `packages/keys/test/audit-signing.test.ts` and `apps/edge/test/audit-signing.test.ts` (workerd: a JWK imports and signs RFC 8032's known answer; a mismatched `x` is refused); `apps/web/test/audit-routes.test.ts` holds that the private half reaches no response, log line, or export, through `/api/audit/keys`, `/api/health`, `/api/account/export`, and the redacting logger; `packages/db/test/audit-chain.test.ts` that an export never carries a private key; `packages/voice/test/clip-store.test.ts` that the clip key is non-extractable and a moved record doesn't decrypt.

## More information

- [Rotating the vault master key](../vault-key-rotation.md): the runbook.
- `packages/keys/src/vault.ts` holds the envelope encryption and `loadVaultMasterKey`, and `packages/keys/src/validate-handler.ts` the validation handler; server code imports both from `@earshot/keys/server`.
- `packages/db/src/vault.ts` holds vault storage, `packages/db/src/vault-rotation.ts` the rotation, and `packages/db/scripts/rotate-vault-key.ts` the script.
- `apps/web/lib/keys/` holds the routes' logic, the label rule, the reason copy, and the browser client; `apps/web/components/keys/` the Settings → Keys components; `packages/db/src/demo-crm.ts` the demo CRM.
