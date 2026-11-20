# ADR-0033: Tamper-evident approvals: a per-workspace hash chain, signed checkpoints, the signing key and its rotation, the sign-in context, and step-up

## Status

Proposed (2026-11-20). Phase 5 WP2 built the hash chain and its trigger (migration 0013), signed checkpoints, the signing key with its script, rotation, and development key, `/api/audit/keys`, the export's audit sections and the offline check (`db:audit-verify`), the health flag, and the sign-in method on each session. WP3 writes the review rows and their checkpoints (the web Worker's review route and the flush consumer); WP11 adds the step-up for policy changes. The browser's saved head (WP2 step 8) was cut, first on the spec's list; see "Cut" below.

## Context and problem

Phase 5 lets a rep approve CRM writes from an inbox, and Phase 6 will sync what they approved. The plan asks for "signed approvals": a later reader, the rep included, should be able to tell whether the record of who approved what has been changed.

- `audit_log` is append-only for the app's role (ADR-0019), but the owner role that runs migrations can edit or delete any row, and so can anyone holding a copy of the database.
- A WebAuthn prompt per approval costs seconds (a passkey sign-in averaged 8.5 s in FIDO's October 2025 index), shows no transaction text, so it can't prove the rep saw the diff, and would break the inbox's 4 s median.
- Reviews arrive through two Workers: the web Worker for the inbox, and the edge Worker's flush consumer for the capture tray (ADR-0032).
- Each review has to say how its reviewer signed in.

## Considered options

- **The record:** **a hash chain per workspace, built by a database trigger, with checkpoints signed in the Worker (chosen)**; a WebAuthn assertion per approval or per batch; R2 bucket locks as a write-once store (anyone who can edit the bucket's settings can lift them); calling the result non-repudiation.
- **Who computes the chain:** **Postgres, in a `BEFORE INSERT` trigger (chosen)**, so every writer chains without changes and the app can't choose a seq or a hash; each writer in TypeScript.
- **The text each hash covers:** **one SQL function, `audit_entry_canonical`, used by the trigger, the check, and the export (chosen)**; a canonical JSON computed in TypeScript; storing each row's canonical text.
- **The key's form:** **a private JWK in one Worker secret (chosen)**; PKCS#8 plus a separate public key (the fallback if workerd couldn't import a JWK).
- **The sign-in method:** **a `sign_in_method` column on Better Auth's session row, set by a `session.create.before` database hook from the endpoint's route (chosen)**; `after` hooks on the three sign-in endpoints; Better Auth's last-login-method plugin (it exists in 1.7.22, but records the user's latest method on the user row, not each session's).

## Decision

### The chain (migration 0013)

`audit_log` gains `chain_seq bigint`, `prev_hash bytea`, and `entry_hash bytea`, all `NOT NULL`, with a unique `(workspace_id, chain_seq)` and checks that seqs are positive and hashes are 32 bytes.

**The trigger,** `audit_log_chain`, `BEFORE INSERT FOR EACH ROW`, a `SECURITY DEFINER` function owned by the table's owner, with `search_path` pinned to `pg_catalog, pg_temp` and every name qualified:

1. `pg_advisory_xact_lock(hashtextextended('earshot.audit:' || workspace_id, 0))`: one writer per workspace until its transaction ends.
2. Reads the workspace's head (highest `chain_seq`) as the owner, so the tenant role's RLS doesn't decide what it sees. Under `READ COMMITTED`, the read after the lock takes a fresh snapshot and sees the row the last holder committed; a writer at a stricter isolation level would collide on the unique key instead of forking the chain.
3. Sets `chain_seq` to the head's plus 1, `prev_hash` to the head's `entry_hash` (32 zero bytes for the first row), and `at` to `greatest(clock_timestamp(), head's at)`: the clock, read once the lock is held, and never earlier than the row before. It overwrites whatever the insert sent. So along each workspace's chain `at` never runs backwards: not for a writer that waited for the lock (the transaction's `now()` would have been its start), nor if the clock steps back.
4. Sets `entry_hash = sha256(prev_hash || convert_to(audit_entry_canonical(NEW), 'UTF8'))`.

Existing writers (the vault, the demo CRM, the account export, the vault rotation) chain without changes. Drizzle sends `DEFAULT` for the three columns (`$defaultFn(() => sql\`default\`)`), which is NULL until the trigger fills it, so inserts can leave them out and `NOT NULL` still holds.

**The canonical text,** form 1:

```sql
json_build_array(1, r.workspace_id::text, r.chain_seq, r.actor_user_id, r.action, r.subject_type,
                 r.subject_id, r.detail,
                 to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
```

Every part has a rendering no server setting changes: the uuid and text columns as JSON strings (lowercase uuid; JSON escapes for `"`, `\`, and control characters; everything else as UTF-8 under the UTF8 server encoding that both PGlite and Neon use), the seq as an integer, `detail` in jsonb's own text form (keys ordered by length then bytes, which jsonb's binary format fixes; `": "` and `", "` between parts; numbers as stored, so `1.50` stays `1.50` and `1e3` reads back as `1000`), and the time through `to_char` in UTC to the microsecond rather than through `DateStyle` or `TimeZone`. Tests pin it:

- pgTAP renders two rows to exact golden strings under a hostile `DateStyle`, `TimeZone`, and `extra_float_digits`.
- On 2026-11-20, 32 rows with Unicode, emoji, combining marks, U+2028, control characters, escapes, duplicate keys, numbers written every way, nested empties, and times before 1970 and after 2099 rendered to byte-identical canonical texts and SHA-256 hashes on PGlite's PostgreSQL 18.6 and a local PostgreSQL 17.4, each under different settings. The same check on Neon's version is left for the first deploy (spec Appendix B, #16).

If a later Postgres ever rendered jsonb differently, `audit_chain_verify` would report false alarms, and storing each row's canonical text at insert time would fix it.

**The backfill:** existing rows are chained per workspace in `(at, id)` order, then the columns become `NOT NULL` and the trigger is created.

**The check,** `audit_chain_verify(workspace)`, returns the first seq at which the chain doesn't hold, or NULL: a missing seq (a deleted or moved row), a `prev_hash` that isn't the previous row's hash, or an `entry_hash` that isn't the hash of the row as it stands (an edit, including to the actor or the time). Then every checkpoint must name a row that is still there with the hash it signed, which catches a chain rewritten from some row on with its hashes recomputed. It runs as the invoker, so for the tenant role RLS confines it to the transaction's own workspace.

`PUBLIC` can execute none of the three functions. The app may run `audit_entry_canonical` (to build exports) and `audit_chain_verify`; the trigger function needs no grant, since `EXECUTE` isn't checked when a trigger fires.

### Checkpoints

`audit_checkpoints`: `id`, `workspace_id`, `chain_seq`, `entry_hash`, `signed_at`, `kid`, `signature` (64 bytes), and `request` (`review`, `flush`, `policy`, or `export`). A tenant table with RLS (`tenant_isolation`) and only `SELECT` and `INSERT` for the app, like `audit_log`. `(workspace_id, chain_seq)` references the chain row, so even the owner can't delete a checkpointed row without deleting its checkpoint first, while deleting a workspace removes both.

One checkpoint per review request: each web request with reviews and each flush message carrying review events (WP3), and each policy change (WP11). And one per account export, which the spec didn't list: the export writes its `account.exported` entry, then signs that head as an `export` checkpoint in the same transaction, so a file the rep downloads is signed through its last entry. Without it every export would end in an unsigned entry, its own, and couldn't pass the check below. With no signing key the export still downloads, unsigned at its end. The signed text is exactly

```json
{"v":1,"wid":"<uuid>","seq":<n>,"head":"<64 hex>","ts":"<ISO, ms, Z>","kid":"<kid>"}
```

members in this order, no spaces, each part checked first (`checkpointMessage` in `@earshot/keys`), and Ed25519 signs its UTF-8 bytes. Any verifier rebuilds it from the row: `head` is `entry_hash` in hex, `ts` is `signed_at` with milliseconds.

**The data layer** (`packages/db/src/audit-chain.ts`), each in a transaction from `withTenant`:

- `recordAudit(tx, entries)` appends entries in the tenant's user's name, in order, and returns them with the new head.
- `writeCheckpoint(tx, signer, head, request)` signs the head and stores the checkpoint. It refuses a head from another workspace, or one that doesn't match the stored row.
- `exportAuditChain(tx)` returns the workspace's chain in seq order, each row with its hashes in hex and its canonical text from Postgres, and its checkpoints.

Writers take any session lock first, then the audit lock, and insert audit rows late in the transaction: the audit lock serializes the workspace's writers until commit.

### The signing key

- **The secret,** `EARSHOT_AUDIT_SIGNING_KEY`, on both Workers: a private JWK, `{"kty":"OKP","crv":"Ed25519","d":…,"x":…,"kid":"audit-2026-11-20-a1b2"}`.
- **Importing it in workerd** (spec Appendix B, #1): workerd's WebCrypto imports an Ed25519 private JWK and signs RFC 8032's test vector to the published answer, so PKCS#8 isn't needed. Unlike Node, workerd doesn't check a JWK's `x` against its `d` on import, so `loadAuditSigningKey` signs a probe and verifies it with `x`; a mismatched key is refused before it can sign anything that `/api/audit/keys` would fail to verify.
- **The loader,** `loadAuditSigningKey(env, { development })` in `@earshot/keys/server`, returns `configured`, `development`, `missing`, or `invalid` (with a message that names the variable, never the value). It never throws for a bad value. The key is imported non-extractable, and nothing returns, logs, or throws it. The web app's redacting logger scrubs the value whole and its `d` alone, which survives JSON escaping.
- **Development** uses a committed key (`DEV_AUDIT_KID`, `audit-development`), as the ticket secret has a development value. The caller decides "development" the way it does for the ticket secret: `next dev` in the web app, `DEPLOY_ENV=development` in the edge Worker. Anywhere else the development key is refused as `invalid`. Since anyone can sign with it, `db:audit-verify` counts its checkpoints as unsigned unless asked (`--allow-development-key`), and recognizes it by its public half (`isDevelopmentAuditKey`), so listing it under another kid doesn't disguise it.
- **The script,** `pnpm --filter @earshot/keys audit-key:new`, prints a new secret value and its public JWK, and writes no file.
- **Public keys:** `GET /api/audit/keys` answers `{ keys: [{ kid, alg: "Ed25519", x, status, retiredAt? }] }`, without sign-in, `cache-control: public, max-age=300`. The active key comes from the secret's public half, the retired ones from the public variable `EARSHOT_AUDIT_RETIRED_KEYS`, a JSON array of public JWKs, each with an optional `retiredAt`. An entry holding a private key (`d`) is refused; then the route answers 500 and serves nothing, never a partial list.
- **Rotation:**
  1. Make a new key with `audit-key:new`.
  2. Add the old key's public JWK to `EARSHOT_AUDIT_RETIRED_KEYS`, with `retiredAt` set to when the new key goes live.
  3. Set the new secret on both Workers.

  A retired key's signature counts only up to its `retiredAt`. Each key needs its own `kid`.
- **Failing closed:** outside development, with no usable key, the review route will answer 503 `audit_unavailable` and `SessionDO` will refuse `review` with `internal` and apply no policy (WP3). `/api/health` reports `audit.signingKey` (`configured`, `development`, `missing`, or `invalid`), never the key, and doesn't count it in `status`: until the key is set, only writes that need a checkpoint fail, and the preview smoke test, which requires `status: "ok"`, keeps passing on deployments without the secret.

### The export and the check

`GET /api/account/export` now carries, per workspace, `tables.audit_log` as the chain in seq order (each row with `prevHash`, `entryHash`, `at` exactly as hashed, and `canonical`) and `tables.audit_checkpoints` (hashes in hex, signatures in base64url), plus a top-level `audit: { form: 1, keys }` with the public keys. With a signing key, each workspace's head is signed as an `export` checkpoint (above). A broken key configuration never blocks an export: it carries whatever public keys there are. The format version stays 1: everything added is additive.

`pnpm --filter @earshot/db db:audit-verify <file> [--keys <keys.json>] [--allow-unsigned-tail] [--allow-development-key]` (`verifyAuditExport`, pure) first refuses a file that isn't well formed: an Earshot export of form 1, well-formed public keys (`isAuditPublicKey`), and UUIDs for every workspace and checkpoint id. Then it checks, per workspace:

- seqs run from 1 with no gap or repeat;
- each row links to the one before;
- each `entryHash` is SHA-256 of `prevHash`'s bytes and the canonical text as UTF-8;
- each canonical text parses to its own row's columns;
- each checkpoint names a row with the hash it signed, under a valid signature from a key in the list, within that key's retirement;
- the head is signed: `signedThrough`, the highest seq a valid checkpoint that counts signs, reaches the newest row. Development-key checkpoints count only with `allowDevelopmentKey`.

Entries after `signedThrough` are the workspace's `unsignedTail`: chained but signed by nothing, so anyone with the database could have changed or dropped them. The result is `ok` only when the chain holds and every workspace with entries has no unsigned tail. Each tail is a problem, unless `allowUnsignedTail` accepts an export taken between checkpoints: then the result is `intact` with N `unsignedEntries`, and still not `ok`. The command prints "OK" and exits 0 only when the result is `ok`. It exits 2 for an intact chain whose unsigned tail `--allow-unsigned-tail` accepted, and says so ("Chain intact, N entries unsigned"). It exits 1 for anything else.

By default the keys come from the export itself; `--keys` takes the keys saved separately from `/api/audit/keys`, which is stronger, since whoever could rewrite the file could rewrite its keys too. It passes on an export from the route and fails with one byte changed in any covered field. Row ids, a checkpoint's `request`, and the rest of the export aren't covered. Everything it prints from a file goes through `escapeControls`, which writes C0, DEL, C1, line separators, and bidirectional marks as `\uXXXX`, and key ids are also JSON-quoted. With ids checked as UUIDs, a crafted file can't move the cursor, recolour, or reorder the output.

### The sign-in method

Better Auth's `session` table gains `sign_in_method text NOT NULL DEFAULT 'unknown'`, checked against `SignInMethod` (`passkey`, `magic_link`, `github`, `google`, `unknown`). It's declared as `session.additionalFields.signInMethod` (`input: false`, so no request sets it; returned with the session), and set by a `databaseHooks.session.create.before` hook from the route of the endpoint that is creating the session (`lib/auth/sign-in-method.ts`):

| Route | Method |
|---|---|
| `/magic-link/verify` | `magic_link` |
| `/passkey/verify-authentication` | `passkey` |
| `/callback/:id` | the route's `id`, `github` or `google` |
| `/sign-in/social` (an ID-token sign-in, with no redirect) | the body's `provider` |
| anything else, or no endpoint | `unknown` |

The hook does see the endpoint (spec Appendix B, #2): Better Auth runs database hooks inside the endpoint's context and passes it, with `path` set to the endpoint's route. So the `after`-hook fallback wasn't needed. Tests drive magic link, passkey (a software P-256 authenticator), and GitHub (the OAuth endpoints stubbed, no network) through Better Auth's real handler on PGlite. Sessions from before migration 0013 are `unknown`. A review records the method with the session's `created_at` as `signedInAt`. Carrying them to `SessionDO` in tickets (`am`, `sat`) is WP3's.

### What it proves

Tamper-evident up to the last signed checkpoint, not non-repudiation. Edits, deletions, and reordering by anyone with database access but not the signing key show, as far as the newest checkpoint from a deployment key. Rows after it are only chained, and anyone with the database could rewrite or drop them, which is why the check fails on them unless told to accept them. An export from the route signs its own head, so it's signed to its end when a key is configured. Only an earlier copy of the head shows whether signed rows were later dropped from the end along with their checkpoints. An operator holding both the database and the key can rewrite history and re-sign it; only an outside witness stops that: an export the rep kept, the browser's saved head (cut), or a published head.

### Cut: the browser's saved head (WP2 step 8)

Cut first, per the spec's list; exports remain the outside witness. It would go in `GET /api/audit/head?since=<seq>` (the links since the head the device saved and the latest checkpoint). The inbox would check that they extend the saved head, verify the checkpoint's signature with WebCrypto against `/api/audit/keys`, keep the new head in IndexedDB beside the device keys, and warn in Settings → Account on a mismatch.

## Consequences

**Good**

- The database chains every row, including the existing writers', and nothing the app sends can choose a seq, a hash, or a time.
- One signature per request and one hash per row, all server-side: the rep never sees a prompt, and the inbox's 4 s median is untouched.
- An export verifies offline with a file and public keys. It fails on any changed byte the chain or a signature covers, and on any entry no deployment key signed, unless told to accept an unsigned tail, and then it still isn't "OK".
- Each workspace's `at` never runs backwards along its chain.
- workerd imports the JWK, so one secret per Worker holds the whole key, and a mismatched key is refused at load.
- Rotation keeps old checkpoints verifiable, and a retired key can't vouch for anything signed after its retirement.
- Each session says how its user signed in, set by the server from the endpoint, never by a request.

**Bad**

- The canonical text relies on Postgres rendering jsonb the same way across versions. It's pinned by tests and was byte-identical on PostgreSQL 17.4 and 18.6, but Neon's version is checked only at the first deploy, and a change would raise false alarms until canonical texts are stored.
- The audit lock serializes a workspace's writers until each commits, so a slow transaction that writes audit rows delays the next review in that workspace.
- **Must fix before team workspaces:** migration 0004's foreign key sets `audit_log.actor_user_id` to NULL when a membership is deleted (`ON DELETE SET NULL (actor_user_id)`). That changes the row's canonical text, so once a workspace has more than one member, a member leaving would make every row they wrote fail the check, a false alarm. It can't happen in Phase 5: each workspace has one member, whose workspace is deleted with their account. Two remedies, either before workspaces gain members:
  - store each row's canonical text at insert time, hash that, and check it against the row semantically (`canonical::jsonb`), allowing a cleared actor;
  - keep departed actors: stop clearing the column, for instance with a tombstone membership, so the text never changes.
- Rows after the newest checkpoint, such as key changes and demo CRM loads, are chained but not signed until the next review request or export, and the check fails on them until then.
- The development key's private half is public by design, so anything it signed proves nothing. The check counts it only when asked, so a development export fails by default.
- Exports from a deployment without a signing key end in an unsigned entry, so they fail the check by default (they pass only as "intact" with `--allow-unsigned-tail`).
- Neither CI deploy step passes `EARSHOT_AUDIT_SIGNING_KEY` yet. The user generates and sets it at the first deploy (spec §9), when the steps gain it, and WP3 wires it into the edge Worker.

## More information

- Spec: Phase 5 build spec, decision 4, decision 16, §4.5, and WP2.
- `packages/db/migrations/0013_audit_chain.sql`: the columns, the canonical text, the backfill, the trigger, the check, and `audit_checkpoints` with its RLS and grants.
- `packages/db/src/audit-chain.ts`, `packages/db/scripts/audit-verify.ts`: the data layer and the offline check. `packages/db/test/audit-chain.test.ts` and `test/pgtap/90_audit_chain.sql` test them.
- `packages/keys/src/audit-signing.ts`, `packages/keys/scripts/new-audit-key.ts`: the signer, the checkpoint message, public and retired keys, and the key script. `apps/edge/test/audit-signing.test.ts` runs them in workerd.
- `apps/web/lib/audit/keys.ts`, `app/api/audit/keys/route.ts`, `app/api/health/route.ts`, `app/api/account/export/route.ts`, `lib/auth/sign-in-method.ts`, and `lib/auth/server.ts`.
- ADR-0019 (tenant isolation) and ADR-0021 (key handling) gain their amendments in WP14.
