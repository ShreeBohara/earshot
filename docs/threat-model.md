# Threat model (v1.3)

Version 1.3 covers everything up to the end of Phase 5:

- the repository and its pipeline, from v0;
- user accounts and sign-in;
- tenant data in Postgres;
- the session event log;
- AI key handling;
- data export and deletion;
- voice capture, short-lived provider credentials, the session socket and its Durable Object, the Queue flush, and LLM calls on the user's own key (from v1.1);
- the understanding pipeline, the second witness, and the CI smoke eval (from v1.2): the model quotes names and a deterministic linker resolves them, the browser sends each turn's audio to Groq on the user's key, and an opt-in CI job calls a real model on a dedicated key;
- the trust layer (new in v1.3): reviews and the seal, with the web Worker writing a session's log once it's sealed; the audit hash chain and its signing key on two Workers; approval policies; the review inbox and its routes; evidence clips on the device; the recap on the session's own key; corrections and follow-up questions; and the review pilot's static page.

Phase 6 adds CRM adapters and sync. Each phase updates this document. Phase 10 replaces it with a full STRIDE model.

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
- **New in v1.1:**
  - browser capture: microphone access, push-to-talk, and hands-free voice detection (ADR-0022);
  - speech-to-text: the browser streams audio straight to AssemblyAI or Deepgram with a short-lived credential the web app mints from the user's key (ADR-0023);
  - the session socket: a signed, single-use ticket opens a WebSocket to the edge Worker's `SessionDO` (ADR-0023, ADR-0024);
  - the Queue that flushes each session's log to Postgres (ADR-0024);
  - LLM proposal extraction on the user's key, sent with each turn (ADR-0025);
  - the eval harness, which runs in CI on synthetic audio and recorded responses (ADR-0026).
- **New in v1.2:**
  - proposal schema v2 and the understanding pipeline: the model quotes the names it heard, and `SessionDO` resolves them with a deterministic entity linker against the workspace's records (ADR-0027, ADR-0028);
  - the normalizers and the faithfulness check, which re-read every date and amount from the quoted words (ADR-0030);
  - the second witness: with the rep's consent, the browser sends each turn's audio straight to Groq's Whisper on the rep's own Groq key, and `SessionDO` flags proposals where the two transcripts disagree (ADR-0029);
  - eval harness v1: 200 debriefs and two $0 gates in `checks`, plus the opt-in live smoke eval, which calls a real model from CI on a dedicated key (ADR-0031).
- **New in v1.3:**
  - reviews and snoozes over the session socket until the session is sealed, then through the web Worker's routes; undo as a later event; the seal, and the repair path for sessions whose seal never came (ADR-0032);
  - the audit hash chain, built by a database trigger; Ed25519 checkpoints signed in both Workers; the signing key and its rotation; public keys at `/api/audit/keys`; the export's audit sections and the offline check; and the sign-in method on each session (ADR-0033);
  - approval policies: versioned per workspace, a signed snapshot in each session's `start`, and a 5-minute step-up to change one (ADR-0034);
  - the review inbox at `/inbox`, the capture tray on the same card, "accept all", the likely-edit tiers, diff cards over the mirror's history, and the demo CRM's controls (ADR-0035, ADR-0008);
  - evidence clips, each turn's audio encrypted on the device for 24 hours, and the device's storage requests: `persist()` and the Home Screen hint (ADR-0036);
  - the recap: one forced call on the session's own provider and key, after the end (ADR-0037);
  - corrections and follow-up questions, read with no model call, over the socket or, once the session is sealed, through the web Worker's corrections route (ADR-0038);
  - the review pilot's kit: a static `/pilot` page with no account, and the results files participants hand to the maintainer (ADR-0039).

**Out of scope for v1.3**

- CRM credentials and adapters. These start in Phase 6. The vault already encrypts CRM connections the same way as AI keys, but nothing writes them yet. Approvals are recorded, signed, and given a `syncEligibleAt`, but nothing is written to a CRM until Phase 6's sync.
- The Conversation engine (speech-to-speech). It was cut from Phase 3.
- Team workspaces. Every workspace has one member in Phase 5; per-member rules come with team workspaces (see Known gaps).
- Two cuts from Phase 5: the browser's saved audit head (exports remain the outside witness) and voice corrections in the inbox (spec §7, lines 1 and 3).
- Follow-up drafts, moved to Phase 7.

## Assets

| Asset | Where it lives |
|---|---|
| User identities and sign-in sessions | Better Auth tables (`user`, `session`, `account`, `passkey`, `verification`). From v1.3 each sign-in session records how it began (`session.sign_in_method`), set by the server |
| Tenant data: sessions, session events, utterances, proposals, the CRM mirror and its history, the audit log and its checkpoints, approval policies | The tenant tables, under row-level security: 16 at v1.3, with `audit_checkpoints`, `approval_policies`, and `crm_entity_changes` new |
| AI provider keys, on the device | IndexedDB, encrypted with a non-extractable WebCrypto key |
| AI provider keys, in the vault | `credentials`, envelope-encrypted: AES-256-GCM per secret, with its data key wrapped by the master key |
| The vault master key (`EARSHOT_VAULT_MASTER_KEY`) | A Worker secret only |
| `BETTER_AUTH_SECRET`, the Resend API key, OAuth client secrets | Worker secrets, and GitHub environment secrets for deploys |
| The audit signing key, `EARSHOT_AUDIT_SIGNING_KEY` (new in v1.3) | A Worker secret on both Workers: an Ed25519 private JWK with a key id, imported non-extractable. No deployment has one yet. Development signs with a committed key, refused anywhere else |
| Retired audit keys, `EARSHOT_AUDIT_RETIRED_KEYS` (new in v1.3) | A public variable on the web Worker: public JWKs only, each with when it was retired |
| The audit chain (new in v1.3) | `audit_log`'s rows chained per workspace by SHA-256 (`chain_seq`, `prev_hash`, `entry_hash`), and `audit_checkpoints`: an Ed25519 signature over the chain's head per review request, flush with reviews, policy change, and export. Copied into each account export, with the public keys |
| Magic-link tokens | Only a hash is stored, and a token is valid for 5 minutes |
| Session tickets | Signed with `EARSHOT_SESSION_TICKET_SECRET` (both Workers), valid 60 s, usable once; they travel in `Sec-WebSocket-Protocol`. From v1.3 they carry how and when the viewer signed in (`am`, `sat`) |
| Minted speech-to-text credentials | An AssemblyAI token or a Deepgram grant, valid 30–60 s for opening a socket; handed to the browser, never stored |
| The LLM key, per turn | Sent from the device in that turn's `turn_end` message over TLS, used for one extraction, and never written down |
| The recap's LLM key (new in v1.3) | Sent once from the device in `end.recap.key` over TLS, held apart in the client's in-memory outbox until the ack, used for one recap call, and never written down |
| Live session logs | Each `SessionDO`'s SQLite holds its session's events until Postgres confirms a log that ends in `session.sealed`, then for 24 hours |
| Queue messages | Batches of session events (transcript text included, and from v1.3 reviews, recaps, and typed corrections) on their way to Postgres; the dead-letter queue holds refused batches |
| Reviews (new in v1.3) | `proposal.reviewed` v2 events in the session log, the Queue, and Postgres: the decision, the record chosen, what the reviewer saw (the card's values and the CRM's), the review clock's timings, the input and surface, and how the reviewer signed in. Each is also an audit row |
| The recap (new in v1.3) | `recap.created` in the session log, the Queue, and Postgres (`sessions.recap`): a few sentences that quote the rep, each with its evidence |
| Typed corrections (new in v1.3) | `utterance.final` v3 events with `input: "typed"`, in the session log, the Queue, and Postgres, like every other transcript |
| Microphone audio | Streamed from the browser to the speech-to-text provider; with the second witness on, each turn's audio also goes from the browser to Groq. Never sent to Earshot's servers |
| Each turn's audio (new in v1.2; for clips too in v1.3) | The page's memory: from the press to the release plus 200 ms, capped at 120 s. Sent to Groq when the witness runs, then dropped; with evidence clips on, also encrypted into the clip store |
| Evidence clips: each turn's audio, kept to replay while reviewing (new in v1.3) | The recording device only: IndexedDB `earshot-evidence`, one record per turn, AES-GCM under that database's own non-extractable key, each record bound to its id. Never played after 24 hours; deleted when Earshot next opens or comes back into view, before each write, at sign-out (everything, the key included), and when clips are turned off. Never sent anywhere (ADR-0036) |
| The Groq key, for the second witness (new in v1.2) | On the device with the other AI keys; decrypted in the page and sent straight to `api.groq.com` in an `Authorization` header, once per turn, never through Earshot. (A rep who also picks Groq for extraction sends the same key on `turn_end`, as in v1.1) |
| The second witness's transcripts (new in v1.2) | `utterance.final` events marked unbiased, in the session log, the Queue, and Postgres, like every other transcript |
| What the linker read for each turn (new in v1.2) | `SessionDO`'s SQLite (`turns`): the records and context a turn's targets were linked against, so a late witness is compared the same way. Deleted with the session's storage |
| Approval policies (new in v1.3) | `approval_policies`, a tenant table under row-level security, append-only for the app: one row per version of a workspace's policy, each change also an audit entry and a checkpoint. Each session's snapshot of the policy rides in its `start` message, signed for that session with `EARSHOT_SESSION_TICKET_SECRET`, and `SessionDO` keeps it, without the signature, in its SQLite until the session's storage is deleted (ADR-0034) |
| The mirror's history (new in v1.3) | `crm_entity_changes`, a tenant table under row-level security, append-only for the app: one row per change to a mirror record's field, its value before and after, when, and whether the demo CRM's controls or a sync made it. A record's history goes with it and with its workspace; it's exported with the account (ADR-0008) |
| Pilot results files (new in v1.3) | A JSON file a participant downloads from `/pilot` and hands to the maintainer: decisions, the record chosen, input kinds, active times, the card shown, when the session started and finished, and the browser's engine and whether it's a phone or tablet. Until the download, progress lives in the tab's `sessionStorage`. The maintainer keeps the files outside Earshot, deleted after Phase 8's report and within 12 months (ADR-0039) |
| `EVAL_SMOKE_ANTHROPIC_KEY`, and the optional `EVAL_SMOKE_GROQ_KEY` (new in v1.2) | The `eval-smoke` GitHub environment only; a key from a separate workspace with its own monthly spend limit |
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

  Everything else runs inside `withTenant`, which switches to the `earshot_app` role and pins one workspace and user for the transaction. From v1.3 one trigger also runs as the owner: the audit chain's, which reads each workspace's head whoever inserts.
- **Workspace to workspace.** Row-level security keys every tenant row to `app.workspace_id`.
- **Device to server, for AI keys.** A key leaves the device only in the `x-earshot-provider-key` header of a single request, over TLS, or on the session socket in `turn_end.key` or, from v1.3, `end.recap.key`. The server writes it down only if the user puts it in the vault.
- **Worker to third parties.** These include:
  - AI providers' key-validation endpoints;
  - Resend, for magic-link email;
  - GitHub and Google, for OAuth;
  - AssemblyAI and Deepgram, to mint short-lived credentials (web Worker);
  - Anthropic and Groq, for proposal extraction and, from v1.3, the recap, optionally through Cloudflare AI Gateway with logging off (`SessionDO`).
- **Browser to speech-to-text provider.** Audio goes straight from the browser to the provider over TLS, opened with a credential that only works for a few seconds. Earshot's servers never see the audio.
- **Browser to Groq, for the second witness (new in v1.2).** Only after the rep says yes, once per device, and only with a Groq key on the device. Each turn's audio goes over TLS to `api.groq.com` with the rep's long-lived Groq key, because Groq has no short-lived credential to mint (ADR-0029 amends ADR-0002 and ADR-0021 for this). Groq's CORS allows the call from the page. On this path Earshot's servers see neither the audio nor the key; they get only the transcript, through the session socket.
- **CI to Anthropic, for the smoke eval (new in v1.2).** Off unless the repository variable `EVAL_SMOKE_ENABLED` is `true`. The key reaches only jobs in the `eval-smoke` environment, on `workflow_dispatch` or on pull requests from branches in this repository.
- **Browser to the edge Worker.** The session socket opens only with a valid ticket for that session and an allowed `Origin`. Cookies play no part, so another site can't ride a signed-in browser.
- **`SessionDO` to Postgres.** Events go through a Queue to a consumer that writes them with `withTenant`, as the session's own user and workspace.
- **Two writers of one session's log (new in v1.3).** Until a session is sealed, only `SessionDO` writes its log, through the Queue. Once Postgres holds `session.sealed`, only the web Worker does, as the viewer under `withTenant` and the session's advisory lock: reviews, snoozes, corrections, and skipped questions (ADR-0032).
- **The web Worker to the edge Worker.** Through the `EDGE` service binding: the health check's request, and two RPC methods that HTTP can't reach, `purgeSessions` and, from v1.3, `sealSessions`.
- **Public internet to Workers.** Preview and production URLs on workers.dev are public. From v1.3, `/api/audit/keys` answers without sign-in, with public keys only.
- **The pilot page to its participant (new in v1.3).** `/pilot` is static: no sign-in, no database, no edge Worker, and no provider. What it records stays in the tab until the participant downloads a file and hands it over in person.
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
| A stale session doing something drastic | Deleting the account, adding a passkey, and storing a key in the vault all need a sign-in from the last hour. Changing an approval policy needs one from the last 5 minutes, by a method Earshot recorded (new in v1.3) |
| A review or a policy change claiming a sign-in it didn't have (new in v1.3) | Each sign-in session's method is set by a server hook from the endpoint that created it (`/magic-link/verify`, `/passkey/verify-authentication`, an OAuth callback), and no request can set it (`input: false`). Inbox reviews and policy changes record it with the session's start; socket reviews get it from the signed ticket's `am` and `sat`, and a ticket without them records `auth: null`, unknown. Sessions from before Phase 5 are `unknown`, which the step-up refuses. Tests drive magic link, passkey, and GitHub through Better Auth's real handler. |
| An open redirect after sign-in | `?next=` is checked after normalization. It must be a single-slash path on our own origin with no backslashes or control characters. Tests cover about 440 generated variants. |
| Secrets or personal data in logs | Better Auth's log hook writes only the level and a redacted message. Our logger records errors by name and code, never by message, because driver errors quote query parameters. Email addresses are never logged. |
| A deployment with a weak or missing auth secret | Outside development, auth refuses to start without a long `BETTER_AUTH_SECRET` and an https base URL. In production it refuses to send magic links without an email provider, rather than printing them. |

### Tenant data

| Threat | Mitigation now |
|---|---|
| An app bug reading or writing another workspace's rows, such as a missing `where` or an id taken from a request | Row-level security covers all 16 tenant tables and fails closed: with no workspace set, nothing matches. Composite foreign keys `(workspace_id, x_id)` stop a row from referencing another workspace's row, because foreign-key checks bypass RLS. 411 pgTAP assertions in 13 files run in CI, including catalog checks that fail when a table with a `workspace_id` lacks RLS or a grant reaches an unprotected table. |
| A member adding someone to their workspace, or promoting themselves | The app role can only read `workspace_members`. Membership is written by trusted code on the owner connection: the creator becomes owner at sign-up, and later invites will need the invitee to accept. |
| Writing a session, an audit entry, or a policy version in someone else's name | RESTRICTIVE policies require `sessions.user_id` (on insert, update, and delete), `audit_log.actor_user_id` (on insert), and, from v1.3, `approval_policies.created_by` (on insert) to equal `app.user_id`. Composite foreign keys tie each to a membership. |
| Rewriting history | The event log is append-only for the app role: no UPDATE or DELETE on `session_events`. The audit log is append-only too, and from v1.3 also hash-chained and signed (see "The audit chain and its signing key"). `audit_checkpoints`, `approval_policies`, and `crm_entity_changes` are append-only for the app as well. Projections can always be rebuilt from the log, and the rebuild is deterministic. |
| Learning that another workspace's session exists | An append to a session outside the workspace fails before the insert, so no unique-key error can hint at the other workspace's events. The session lock includes the workspace, so another workspace can't contend for it. |
| An export leaking secrets | The export leaves out tokens, password hashes, and envelope-encrypted material. Credentials appear as provider, label, last 4 characters, and timestamps. From v1.3 it carries the audit chain, its checkpoints, and public keys only. Tests seed known secrets, the audit signing key's private half among them, and scan the export for them. |
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

### Voice sessions (new in v1.1)

| Threat | Mitigation now |
|---|---|
| A stolen session ticket | A ticket lives 60 s, names one session, and works once (its `jti` is remembered). The first connection pins the user and workspace, so a ticket for another user is refused (close 4007). Tickets are added to the logger's exact secrets. |
| Another site opening a session socket in a signed-in browser | The socket checks `Origin` against `WEB_ORIGIN` and needs the ticket in `Sec-WebSocket-Protocol`; it doesn't use cookies |
| A minted credential leaking the user's key | Credentials are minted server-side from the key in `x-earshot-provider-key`. The provider's response body is never forwarded, a credential containing any 8-character run of the key is refused, and minting is signed-in and rate-limited. Credentials live seconds and aren't stored. |
| A Deepgram grant or other credential reaching the session log | The session protocol refuses key- and JWT-shaped strings anywhere but `turn_end.key` and, from v1.3, `end.recap.key` |
| The per-turn LLM key being kept | It rides only on `turn_end`, is held apart from the message in the client's in-memory outbox and dropped on the ack, and is used for that one call. Canary tests scan `SessionDO`'s SQLite, the Queue messages, socket frames, and logs for it. |
| Flooding a session | A token bucket (20 messages a second) closes the socket at the first message over the rate, so nothing after it runs out of order. Turns are capped at 30 per 10 minutes, capture at 30 minutes, messages at 64 KB, and utterance text at 4,000 characters. From v1.3 corrections have limits of their own (below), and a review message carries at most 25 reviews. |
| Losing or reordering events on a bad network | Events are sequence-numbered and acknowledged; a reconnecting client resumes from its last seq, and resends are deduplicated by msgId. The Postgres flush is idempotent, and the log is append-only. |
| A transcript lingering after it should be gone | `SessionDO` deletes its storage 24 hours after Postgres confirms the whole log, which from v1.3 means a log that ends in `session.sealed`, and ends a session nobody ended once it's been idle past its limit. Deleting an account purges the Durable Object storage of its sessions first, and stops, deleting nothing, if that fails. |
| Prompt injection through what's said in a debrief | The model can only return proposals in a fixed schema, which are validated. Every field must quote words that appear in the transcript, or it's flagged and dropped. Nothing is written to a CRM: from v1.3 every proposal waits for a person's review or for a policy the rep chose, which takes only unmarked cards, and nothing syncs until Phase 6. |
| The microphone staying on | Push-to-talk is the default. Ending a session releases the microphone, including a permission prompt answered after the end. On iOS, hiding the page suspends capture. |
| Test-only code shipping to production | Build checks fail if the fake speech-to-text adapter, cassette extraction, the e2e scenario route, `@earshot/evals`, or PGlite reach a production bundle |

### Understanding and the second witness (new in v1.2)

| Threat | Mitigation now |
|---|---|
| A second company processing the rep's audio (Groq) | The witness is off until the rep says yes, asked once per device and only when a Groq key is on it; unanswered means off. The prompt tells the rep to turn on Zero Data Retention under Data Controls in Groq's console first. Each request carries one turn: from the press to the release plus 200 ms, capped at 120 s. Turns under 1 s send nothing. |
| A device key used from the page | The Groq key is decrypted in the page and sent from it, which Groq's CORS allows. So an XSS on Earshot's origin could use it, which is the same exposure the device keys already have (see Known gaps). A test holds that the key goes only to `api.groq.com`, only in the `Authorization` header, and into neither the URL, the request body, the result, nor a log. The session protocol refuses key-shaped strings, so it can't reach the session log either. A future Content Security Policy must allow `connect-src https://api.groq.com`. |
| A client forging the "unbiased" transcript | It can, but only for its own session, and a conflict never writes anything: it adds a `witness_conflict` flag, or turns a link into a question, for the rep to review. `SessionDO` refuses a witness for an unknown turn, a second witness for a turn, a reused utterance id, and times more than 1 s outside the turn, and resends are idempotent by msgId. The witness's text passes the same key-shape and size checks as every other message. |
| Prompt injection steering a proposal to another account | The model no longer chooses CRM records. It gets no list of records and returns only the words it heard; `SessionDO`'s deterministic linker resolves those words against the workspace's own records, with calibrated thresholds, and asks when unsure. Words that aren't in the transcript are never linked (flagged `unsupported`), and a target taken from context alone is flagged `implied_target`. Dates and amounts are re-read from the quoted words, and the model's value is kept beside the reading and flagged when they differ. |
| CRM names reaching a model provider for mining or embeddings | Nothing does in Phase 4. Confusion mining (WP6) hasn't run, and when it does its clips use fictional names only. Embeddings (WP13) were cut and moved to Phase 6; if they come, CRM names go to Workers AI, which lists zero data retention. |
| The CI smoke key being stolen or overspent | The key lives only in the `eval-smoke` environment, which jobs reach only on `workflow_dispatch` or on pull requests from branches in this repository; fork PRs get no secrets. Only the steps that call the model see it, not `pnpm install`, and the workflow passes PR data to the shell through environment variables, never inline. The job is skipped unless `EVAL_SMOKE_ENABLED` is `true`. A budget guard refuses a run whose estimate (× 1.25) passes `EVAL_SMOKE_BUDGET_USD`, and stops one whose measured spend does, and the key comes from a separate Anthropic workspace with a monthly spend limit. The job reports numbers only, never prompts, transcripts, or response bodies. From v1.3 each smoke script also writes a recap, inside the same budget. |

### Reviews, the seal, and the review routes (new in v1.3)

| Threat | Mitigation now |
|---|---|
| Two writers racing on one session's log, so an event is lost or a batch dead-lettered | A session has one writer at a time (ADR-0032). `SessionDO` writes until it appends `session.sealed`, its last event, and refuses every client write after it (`sealed`); the web Worker writes nothing until Postgres holds that event, and checks for it under the session's advisory lock, the one the flush's appends take. Seqs are contiguous, so Postgres holds the seal only once it holds the whole log. A redelivered flush message for a range Postgres already holds is acked as committed, even with the web Worker's events after it: a PGlite test redelivers the original message and the seal's after a web review, with no conflict and no extra audit row. Locks go session first, then the workspace's audit lock, everywhere, so the two can't deadlock. |
| A client forging or replaying a review | Every writer runs the same rules (`checkReview`, `checkReviews`) against the session's own folded log: an approval needs a proposal still open; a question needs one of its own candidates; a reopen must name the latest review; a batch takes only unmarked cards; a superseded proposal takes nothing. Clients can send only `single` and `batch` reviews; `policy` and `system` come only from `SessionDO`. The writer, not the client, fills who reviewed (`by`) and when an approval may sync (`syncEligibleAt`). Reviews are idempotent by `reviewId` across the socket and the route, and an id the log holds for another proposal is refused. A record offered at review time must be in the workspace's mirror, of a kind the proposal's type can target. |
| The review routes as a way in | `POST /api/sessions/:id/reviews`, `POST /api/sessions/:id/corrections`, `PUT /api/policies`, and `GET /api/inbox` need a sign-in and refuse a request a browser marks `cross-site` or `same-site` (`Sec-Fetch-Site`), as the key routes do. Bodies are capped before they're read: 64 KiB and 25 items for reviews, 64 KiB for corrections, 16 KiB for policies, with an oversized `Content-Length` refused unread. Nothing shaped like a provider key is accepted in a body. Each write runs in one `withTenant` transaction as the viewer, so row-level security keeps it inside the workspace, and a session that isn't the viewer's own answers 404, like one that doesn't exist. Answers are `no-store`, with fixed codes, and quote nothing from the request. |
| An approval reaching the CRM before the reviewer could undo it, or after they did | Nothing syncs in Phase 5. Each approval records `syncEligibleAt`, its time plus 30 s, and Phase 6's outbox may sync only sealed sessions whose latest review approves, never before `syncEligibleAt`, re-reading that review right before writing. Undo is a later event (`reopened`) and deletes nothing, so the log keeps both decisions. |
| A conflict found after an approval | A witness flag on an approved or edited proposal makes `SessionDO` append a reopen (`mode: "system"`, `reason: "flagged"`) in the same transaction, for a policy's approval too. A workerd test runs it. |
| A session that never seals, or the repair path turned on someone else's session | The inbox's loader asks the edge Worker about at most 20 of the viewer's own sessions that ended more than 10 minutes ago (or never ended and started more than 2 hours ago), through `sealSessions`, an RPC on the service binding that HTTP can't reach, at most 500 ids a call. Only a session whose object holds nothing (`gone`) is sealed in Postgres, under the session's lock; `live`, `sealing`, and `sealed` are left alone, and an edge Worker that doesn't answer within 3 s skips the repair rather than holding the page. |
| Reviews stored without their audit rows | Both writers fail closed without a usable signing key (below), and a flush redelivery writes no second row. Snoozes and corrections approve nothing, so they write no audit row and need no key. |
| Sample debriefs reaching another workspace | "Load sample debriefs" (a server action, whose `Origin` Next.js checks) imports sealed logs into the viewer's own workspace: every id derived from the workspace and the original, records mapped to the workspace's own demo CRM rows, and loading twice adds nothing. |
| What a reviewer saw reaching logs | The routes and `SessionDO` log fixed reasons, counts, and positions, never an id or a value. `seen`, the card's values and the CRM's, is session data, under row-level security. |

### The audit chain and its signing key (new in v1.3)

| Threat | Mitigation now |
|---|---|
| Someone with database access but not the key editing, deleting, or reordering who approved what | A `BEFORE INSERT` trigger chains every `audit_log` row per workspace with SHA-256 over the previous hash and the row's canonical text (one SQL function, which the export uses too), and overwrites whatever the app sends for the seq, the hashes, and the time. Each review request, flush with reviews, policy change, and export signs the chain's head with Ed25519 in the Worker that wrote the rows. `audit_chain_verify` reports the first seq where a link, a hash, or a checkpoint no longer holds, and the offline check (`db:audit-verify`) does the same on an export, signatures included. pgTAP edits, deletes, and reorders rows as the owner and finds each at its seq; a test changes one byte of an export and the check fails. |
| An operator holding both the database and the signing key | They can rewrite history and sign it again: the chain is tamper-evident, not non-repudiation. Only an outside witness catches it: an export the rep kept, checked with the public keys saved from `/api/audit/keys` (`--keys`), or a head published elsewhere. The browser's saved head, which would have been one, was cut (see Known gaps). |
| Rows after the newest checkpoint | They're chained but signed by nothing, so anyone with the database could change or drop them. The offline check fails on an unsigned tail unless told to accept it (`--allow-unsigned-tail`, which still isn't "OK"). An export from the route signs its own head first, so with a key configured it's signed to its end. |
| The signing key leaking | It's a Worker secret on the two Workers that sign, imported non-extractable. The loader never throws, logs, or returns it, and the redacting loggers scrub the value and its `d`. Tests hold that the private half reaches no response, log line, or export (`apps/web/test/audit-routes.test.ts`, `packages/db/test/audit-chain.test.ts`). To rotate it: a new key with its own key id, and the old public key added to `EARSHOT_AUDIT_RETIRED_KEYS` with its `retiredAt`. A retired key's signatures count only up to then, so a leaked old key can't vouch for anything signed after its retirement. A retired entry holding a private key makes `/api/audit/keys` serve nothing. |
| The development key, which anyone can sign with | It's committed on purpose and refused outside development (`invalid`). The offline check counts its checkpoints as unsigned unless asked (`--allow-development-key`), recognizing it by its public half under any key id. |
| No key, or a broken one, in a deployment | Writes that need a checkpoint fail closed: the review and policy routes answer 503 `audit_unavailable` before touching the database, `SessionDO` refuses `review` with `internal` and applies no policy, and the flush retries a message carrying reviews and stores nothing. `/api/health` reports the key's state (`configured`, `development`, `missing`, or `invalid`), never the key. An export still downloads, unsigned at its end, and fails the check by default. A key whose public half doesn't match its private half is refused when it loads, by a probe signature. |
| A crafted export attacking whoever checks it | The check refuses a file that isn't an export of form 1 with well-formed public keys and UUIDs for every workspace and checkpoint id, and writes everything it prints from the file with control, line-separator, and bidirectional characters escaped. |
| Postgres rendering the canonical text differently | It would raise false alarms, not hide changes. The text is pinned by golden strings under hostile settings in pgTAP, and was byte-identical on PGlite's PostgreSQL 18.6 and PostgreSQL 17.4; Neon's version is checked at the first deploy. |

### Evidence clips (new in v1.3)

| Threat | Mitigation now |
|---|---|
| Audio at rest on the device, read by anyone with the browser profile's files | Each clip is AES-GCM under a 256-bit key generated non-extractable and stored as a `CryptoKey`, in a database of its own (`earshot-evidence`), apart from the device keys' database and key. The ciphertext alone leaves the audio unreadable; the key can't be exported by script. |
| A clip moved or swapped into another debrief's place | The additional data is `earshot-clip:v1:<sessionId>:<turnId>`, built from where a record is stored, so a record moved to another id doesn't decrypt there, and the store deletes it. A record whose fields claim a session its id isn't in is ignored. Tests move records between turns and sessions. |
| A clip outliving 24 hours | Never played after 24 hours, whether or not it's been deleted yet: the store refuses an expired record, and every press reads the store. Deleted when Earshot opens or comes back into view, before each write, and at sign-out. No browser runs code at the 24-hour mark, so a device Earshot isn't opened on keeps expired, encrypted clips until it is (see Known gaps). |
| A clip reaching Earshot's servers or a third party | There's no path: the clip modules (`@earshot/voice/evidence`, `apps/web/lib/evidence`, `apps/web/components/evidence`) have no request, socket, cross-window message, server action, or log, which a test checks in their source; no route touches clips, which a test checks too; the session socket's messages are strict schemas with no field for audio. The fake-microphone e2e test records every body the page sends while a turn is kept and played: none reaches a second of audio. The second witness still sends each turn's audio to Groq, with consent, on the rep's key, unchanged (ADR-0029). |
| The next person on a shared device hearing the last rep's debriefs | The clip store belongs to one signed-in user (`earshot.evidence.owner` in localStorage, a user id). When the app opens for anyone else, or for a store with no recorded owner, every clip and the key are deleted before anything is kept, however the last session ended: signed out here, expired, or signed out from another device. A page keeps a clip only while its viewer still owns the store, so a tab left running a debrief after another user signs in keeps nothing more. Signing out from the account menu, or deleting the account, stops capture, deletes every clip and the key, and forgets the owner, which other tabs hear as a `storage` event; they stop playing, and keep nothing more. Turning clips off deletes them. An e2e signs a second user in after the first one's session ended without the menu, and finds no clip and no key. |
| Playback feeding back into a live debrief | While a clip plays, a hands-free engine takes no microphone audio, and pressing push-to-talk stops the clip, so a clip can't become a turn. |

### The recap (new in v1.3)

| Threat | Mitigation now |
|---|---|
| The recap's key being kept | It rides only on `end`, at `end.recap.key`, the protocol's one key slot besides `turn_end.key`. The client's in-memory outbox holds it apart from the message until the ack, as it does a turn's key; `SessionDO` holds it in the recap call's closure for that one call, and never stores or logs it. Canary tests, Anthropic-shaped and plain, scan `SessionDO`'s SQLite, the Queue messages, socket frames, and logs for it (`apps/edge/test/sessions/recap.test.ts`, "the recap's key"). A key-shaped string anywhere else in `end` is refused. |
| A recap saying what the rep didn't (an invented commitment, a paraphrase that changes it, or prompt injection through what's said) | The model can only return sentences in a fixed schema, each with quotes. Code locates every quote in the session's own transcript and drops a sentence with none, and the recap says how many were dropped; a sentence that says more than its words is marked and shown with a note; a lens field whose quote isn't there is "not mentioned". Every kept sentence opens the words behind it. The $0 gate in `checks` holds that every seeded bad sentence and invented lens quote is dropped. Nothing in a recap is written to a CRM. |
| A recap holding the seal or the tray | Reviews don't wait on it. The seal does, for at most the recap's 15 s deadline; a failure or timeout is recorded as such and the seal goes on. A recap lost to a restart is recorded as failed when the session seals. |
| A recap's words reaching logs | `SessionDO` logs counts and codes only (outcome, reason, sentences, dropped, weak, lens, mentioned). The live smoke eval and the live check report numbers only. The recap itself is session data: it's flushed to Postgres with the log, into `sessions.recap`, under the same row-level security. |
| A key-shaped string in a recap | The checks drop a sentence shaped like a provider key, and the client refuses any server message carrying one. |

### Approval policies (new in v1.3)

| Threat | Mitigation now |
|---|---|
| A client claiming a policy its workspace doesn't have, or a looser one | `SessionDO` reads no database on the turn path, so the policy comes in `start`, signed by the web app: base64url HMAC-SHA256 with the ticket secret over `"earshot.policy.v1."` and the canonical `{ id, version, rules, sid }`. `SessionDO` verifies it against its own session id with WebCrypto's constant-time `verify` before keeping anything, and refuses a `start` whose snapshot doesn't verify (`bad_message`). Changing any rule, field, version, or id breaks the signature; tests forge each. The prefix keeps the secret's two uses apart: no ticket signature passes for a snapshot's. |
| A snapshot replayed into another session, or an old one into a new session | It's bound to its session id, so it verifies nowhere else, and `POST /api/sessions` signs one per session, from the workspace's latest version. A later `start`'s snapshot changes nothing: a session keeps the policy it started with, and a change applies from the next session. A client that drops the snapshot gets no policy: every proposal waits for the rep. |
| A stale or stolen web session changing a policy | `PUT /api/policies` needs a sign-in from the last 5 minutes (`STEP_UP_SECONDS`), by a method Earshot recorded, checked before the body is read; Settings → Review offers "Confirm with your passkey", or an email link or the sign-in-again page for an account without one. Same-origin only, at most 16 KiB, and the rules held to the contract and `checkPolicyRules`. Every change is a new version (the table is append-only for the app), a `policy.changed` audit entry with the rules' hash and how its author signed in, and a signed checkpoint; a change from an older version is refused (`stale`). |
| A policy approving what a person should see | A policy takes only a proposal with no mark at all (`tierOf` is `none`: no loud reason, no quiet note, no name note), linked to a record, replacing nothing, of a type a rule names, carrying none of the rule's held-back fields. `checkReview` checks the approval again before it's appended. Clients can't write policy reviews: `ReviewInput` takes only single and batch modes, and the writers' rules refuse a machine review from a client. Tests run the evaluation table on the real tiers and on real eval debriefs (a negation, the name note, a held-back amount, a new contact). |
| A later conflict on an auto-approval | As for a person's approval (decision 15): a witness flag on it makes `SessionDO` append a reopen (`mode: "system"`, `reason: "flagged"`) naming the policy's review, in the same transaction. A workerd test runs it. |
| An auto-approval reaching the CRM unseen | Nothing syncs in Phase 5. Phase 6's rule applies to auto-approvals as to a person's: a sealed session, a latest review that approves, not before `syncEligibleAt` (30 s), re-read before writing. Each auto-approval shows in Reviewed, "Approved by your policy: notes", with Undo, then Reopen. |
| Approvals without their audit rows | Without a usable audit signing key, `SessionDO` applies no policy, and `PUT /api/policies` answers 503 `audit_unavailable` before touching the database. Each auto-approval reaches Postgres with a `proposal.auto_approved` audit row naming the policy's id, version, and rule, signed by its flush's checkpoint. |
| A workspace reading or changing another's policy | `approval_policies` is a tenant table under row-level security, keyed by workspace and version, its author bound to `app.user_id` by a RESTRICTIVE policy and to a membership by a foreign key. pgTAP covers the reads, the fail-closed case, the append-only grants, and the actor binding. |
| A policy stopping every session | The socket refuses a `start` holding anything shaped like a key, so the writer refuses a key-shaped rule id, and a signature that happens to look like a key (about one session in 100,000) leaves that session without a policy rather than unable to start. |
| A policy's contents reaching logs | `SessionDO`, the routes, and the writer log counts and codes only: a version number, how many rules, how many proposals were approved and why the rest weren't. |

### The mirror's history, diff cards, and the demo controls (new in v1.3)

| Threat | Mitigation now |
|---|---|
| A workspace reading or writing another's history | `crm_entity_changes` is a tenant table under row-level security, and each change names its record through a composite key, `(workspace_id, entity_id)` to `crm_entities`, so it can't point at another workspace's record even by id. pgTAP covers the reads, the fail-closed case, writing into another workspace, and a change of one's own aimed at another workspace's record. Every data-layer function checks it runs inside `withTenant`. |
| The history rewritten to change what a card shows | Append-only for the app: `SELECT` and `INSERT` only, so no update, delete, or truncate, its own rows included (pgTAP). The app can still insert a change with any time, and it can write the mirror itself: the history is the mirror's account of the CRM, as trustworthy as the mirror. It decides what a card shows (two values or three, an offer or none), never what's written: every CRM write needs an approval (ADR-0007), and Phase 6's sync re-reads the CRM's live value before writing and stops on a conflict. |
| A demo control acting on a real CRM record, or on another workspace's | The server actions take only a card's ids, and do nothing unless the debrief is the viewer's own. "Simulate a CRM change" moves a field only of a demo record (no CRM connection, the `demo:` prefix) in the transaction's workspace, locked first, and only one of six fields; "Add a matching record" adds only in a workspace whose mirror is the demo CRM (demo records, and no CRM connected), and only demo records, which removing the demo CRM removes. Tests try a connection's record, another workspace's, another user's card, malformed ids, and a card that isn't an update. Next.js checks a server action's `Origin`. |
| Something injected through a field's value or a record's name | Values reach SQL only as parameters: the moved value is a JSON parameter to `jsonb_set`, and the field comes from a fixed list. The history's `field` is held to a field name and its `source` to `demo` or `sync` by check constraints. An added record's name is the rep's quoted words, whitespace collapsed, at most 200 characters, never shaped like a key (a session's `start` would refuse it). The inbox renders every value and name as text. |
| An approval policy, or "accept all", taking a 3-way card or a re-link offer | A policy runs once, as `SessionDO` creates the proposal, before anything could have moved, and never on a new record, the only kind a re-link offer is made on. "Accept all" leaves both out, since each is loud at review time, and `checkReview` refuses a batch or policy approval whose `seen` records a CRM change or a re-link offer. Tests cover the page's set, the writers' rule, and the policy table. |
| A page choosing a record nothing offered, through a claimed re-link | `seen.relinked` counts as offered only on a new-record proposal, and the review route refuses one that isn't a record the workspace's mirror holds, of a kind the proposal's type can target. Tests send a record that isn't there and one of the wrong kind. |
| The linker at review time | It runs in the web Worker, in memory, over the workspace's own mirror read under row-level security: no model call, no key, and nothing written. |
| A field's value or a record's name reaching logs or the audit trail | The actions log the field's name or the record's kind only, and their audit entries (`demo_crm.changed`, `demo_crm.record_added`) carry ids and the field or kind, never values. |

### Corrections and follow-up questions (new in v1.3)

| Threat | Mitigation now |
|---|---|
| Typed words used to get around speech's limits (a security review's finding) | Typed words travel only on a `correct` message, never in an `utterance` message, and `SessionDO` writes them as `utterance.final` v3 (`input: "typed"`) only in the correction's own transaction, after its checks pass: no correction, no typed words, and a `turn_end` for a turn holding typed words is refused. A typed correction is at most 500 characters; a session's corrections carry at most 20,000 characters in all; none is taken more than 5 minutes past the 30-minute capture limit (`duration_limit`); and a correction never pushes back the idle end. |
| Corrections flooding a session, or replaying its log on each one (a security review's finding) | Limited like turns: 30 per 10 minutes and 100 per session, every attempt that reaches the checks counted, read or not, and a card corrected at most 5 times over (the depth of its `supersedes` chain). Each is refused `turn_limit` with a fixed reason in the log. `SessionDO` checks a correction against a cached fold of its proposals, not a replay of the log. The socket's token bucket and 64 KB message cap still apply. |
| Corrections through the web Worker after the seal | `POST /api/sessions/:id/corrections` needs a sign-in, refuses cross-site requests, reads at most 64 KiB, and refuses key-shaped strings and text Postgres's jsonb can't store. It works only on the viewer's own sealed session (404, 409 `not_sealed`), in one `withTenant` transaction under the session's advisory lock, so it never overlaps `SessionDO`. In production each viewer may send 30 requests per session in 10 minutes, counted in Postgres before any work (429); in the transaction the log's own limits apply again: 100 corrections, 30 in the window, 20,000 characters of carried words (typed, dictated, or written after the seal), depth 5. Resends find their first answer by the derived proposal id (SHA-256 over the session and the correction's id), across the seal. |
| A correction deciding something, or reaching the CRM | A correction appends a new proposal for review; it approves nothing, writes no audit row, and needs no audit key. Every writer refuses a review of the superseded proposal (tests in the route and the object), a policy never approves a proposal that supersedes another (ADR-0034), and Phase 6 syncs only what a review approved. |
| Words read into the wrong value | The same linker and normalizers as the turn path read them: no model call, no key, no prompt to inject into. Words with no value of the field's kind are refused (`unreadable`, 422) and nothing is written; an ambiguous reading keeps both readings and its flag, so the card stays loud; a currency other than USD is flagged. The corrected field's evidence points at the correction's words, which the card quotes. |
| A dictation's words claiming to be speech | The route takes a dictation's segments (at most 8, each up to 4,000 characters and 200 words) as `input: "speech"`. Nothing proves they came from a speech-to-text provider: they're the client's claim, the rep's own words about the rep's own debrief, and they count against the same 20,000-character budget as typed words. The inbox doesn't send them yet (voice in the inbox is cut). |
| A spoken correction's audio | The capture screen's microphone, in push-to-talk, arms the next turn as the correction: its audio goes to the speech-to-text provider like any turn's, on the same short-lived credential; its words reach `SessionDO` as that turn's utterances and are read by `correctProposal`, never extracted on the LLM key; its clip, with clips on, stays on the device (ADR-0036). |
| Follow-up questions | Rules, not a model: at most 2 a turn, fixed texts, none on a loud card or one a policy approved. A question isn't a flag: the tiers, "accept all", and policies never see it. A skip is idempotent per question, and an answer is a correction under every limit above. |
| A correction's words or values reaching logs | `SessionDO`, the route, and the writers log codes and counts only: typed or speech, whether the field was the record, the linker's decision, the number of flags and questions answered, and a refusal's fixed reason. The words are session data, flushed to Postgres with the log under row-level security. The page quotes back its own copy of the words, never a server's answer. |

### The review pilot (new in v1.3)

| Threat | Mitigation now |
|---|---|
| Keeping personal data about participants | The page asks for nothing: no account, name, email, or address. The results file holds what the consent lists and nothing else: each card's decision, the record chosen, the input kind, active times, and the card as shown; when the session started and finished; and the browser's engine and whether it's a phone or tablet, read from the user agent, which isn't kept. Participants are labelled P1 to P5. No audio, no screen recording, and the debriefs are synthetic. |
| The page sending anything anywhere | `/pilot` is static, like `/demo`: the set is bundled at build time, and the page has no database, account, edge Worker, or provider. A local sink folds the reviews in the page. The `pilot` Playwright project records every request of a full run, a reload included, and fails on anything but static GETs on the page's own origin: no fetch, XHR, POST, or API route. |
| Progress left on a shared laptop | Written to the tab's `sessionStorage` only after "I agree", under the participant's label: a reload keeps the place, and closing the tab keeps nothing. |
| A results file, once handed over | It leaves Earshot: the participant downloads it and gives it to the person running the session, and may read it first. The consent says how it's kept: deleted once the Phase 8 report is written, within 12 months at the latest, or sooner on request. Earshot can't enforce that (see Known gaps). |
| The consent shown differing from the consent written | The page reads `docs/pilot/consent.md` at build time, and the build fails on Markdown it would show wrongly, so the two can't differ. |
| A set changed after the pre-registration | `pilot.v1` is rebuilt byte for byte by a test and by `pilot:gen --check`, and named by its SHA-256, which every results file carries; `pilot:analyze` leaves out, and names, a file for another set. The pre-registration records the hash and the commit before the first session. |
| The pilot timing something other than the inbox | It runs the inbox's own engine, card, keys, and writers' rules (`checkReviews` with `tierOf`), and the scripted reviewer walks it in CI at $0, so a change to the card shows in both. |

## Known gaps

- **Row-level security isn't a sandbox.** It catches app bugs, but code holding the connection, such as a successful SQL injection, could `RESET ROLE` or change `app.workspace_id`. The mitigation is that every query goes through Drizzle with parameters.
- **Inside a workspace, child tables trust every member.** `session_events`, `utterances`, `proposals`, and `sync_jobs` aren't bound to their session's user. Phase 2 has one member per workspace. Team workspaces will need per-member rules, decided when manager review is designed (ADR-0019).
- **Team workspaces will need more than that** (new in v1.3). Phase 5 still has one member per workspace.
  - **Policies:** any member could change the workspace's approval policy, after the step-up, and the policy then covers everyone's debriefs. Roles come with team workspaces.
  - **The audit chain:** deleting a membership clears `audit_log.actor_user_id`, which changes those rows' canonical text, so a member leaving would make every row they wrote fail the chain's check, a false alarm. It can't happen while each workspace has one member, deleted with the account. ADR-0033 records it as a must-fix before workspaces gain members.
  - A live debrief keeps the policy it started with until it ends, even one just turned off, which Undo and Phase 6's sync rule cover.
- **The audit chain is tamper-evident, not non-repudiation** (new in v1.3). An operator who holds both the database and the signing key can rewrite the chain and sign it again; only an outside witness catches that, an export the rep kept or a published head. The browser's saved head, which would have been one, was cut (spec §7, line 1). Rows written after the newest checkpoint, such as key changes and demo CRM loads between reviews, are chained but unsigned until the next review request or export, and the offline check fails on them unless told to accept an unsigned tail.
- **No deployment has an audit signing key yet** (new in v1.3). Neither CI deploy step passes `EARSHOT_AUDIT_SIGNING_KEY`. Until the maintainer generates one (`pnpm --filter @earshot/keys audit-key:new`) and sets it on both Workers, a deployment refuses reviews and applies no policy: closed, not open.
- **XSS could use device keys.** An XSS on Earshot's origin could ask the browser to decrypt them, even though the wrapping key can't be exported. There is no Content-Security-Policy yet; it's planned for Phase 10. Until then, keep dependencies few and render all text as text. Since v1.2 the page also uses the Groq key itself, for the second witness, which adds no new exposure beyond this one. From v1.3 an XSS could also play or decrypt the evidence clips on the device, the last 24 hours of the rep's own words, through the same browser-held key, and could review cards as the signed-in rep through the routes the page uses; the audit chain would record those reviews as the rep's, which is part of why it doesn't claim non-repudiation. A policy change still needs a sign-in from the last 5 minutes.
- **Safari can delete device keys after a week away** (new in v1.3).
  - **The rule:** Safari's 7-day rule deletes a site's script-writable storage, IndexedDB included, after seven days of Safari use without a visit to the site. A rep who uses Earshot in a Safari tab and skips a week loses the keys kept on that device.
  - **What Earshot does:** on iOS Safari, outside a Home Screen app, Settings → Keys says so and suggests the Home Screen. A Home Screen app keeps its own count of days, and its own storage apart from Safari's, so the keys have to be added again there.
  - **`persist()`:** Earshot also asks every browser once to keep its storage (`navigator.storage.persist()`), after the first key is stored on a device, or when evidence clips are turned on (the same request, remembered once). Chrome grants it silently from engagement, and Firefox asks. Safari grants it by heuristics, and the only one WebKit names is opening the site as a Home Screen app, so in a Safari tab it likely doesn't help.
- **Evidence clips can go early, and can outlive their 24 hours** (new in v1.3).
  - **Early:** eviction under storage pressure takes a best-effort origin's storage all at once, clips with the keys, and iOS Lockdown Mode has no IndexedDB at all (not yet checked on a device). Safari's 7-day rule can't touch a 24-hour clip. Designed for: every card works without audio and says why ("No audio on this device", "This browser can't keep audio", and so on), and `persist()` protects clips as it protects keys.
  - **Late:** expired clips are deleted when Earshot next opens on the device, not at the 24-hour mark. They're encrypted and never played after it, but a device Earshot isn't opened on again keeps them.
  - **Sign-out elsewhere:** a session that expires, or is signed out from another device, leaves its clips encrypted in the browser until Earshot next opens there. Then they're deleted, whoever opens it, if the store isn't theirs, and otherwise they expire within 24 hours.
- **The Groq key is long-lived and used from the page** (new in v1.2). Groq offers no short-lived credential, so the second witness sends the rep's own key from the browser on every turn, unlike speech-to-text, whose credentials live seconds. ADR-0029 records the exception. A Groq key used only for Earshot keeps a leak contained.
- **The mirror's history is only as complete as its writers** (new in v1.3). Only the demo CRM's controls write it until Phase 6's sync does. A value that moves in the mirror without a history row shows no 3-way card (the card shows the value now as it always did), and a record that arrives without an arrival row is never offered at review time. Phase 6's sync must record every change, arrivals included, in the same transaction as the change.
- **Corrections can only say what the normalizers and the linker read** (new in v1.3). A value they can't read is refused, and a record the index doesn't hold (`start`'s records live, the mirror after the seal) can't be linked by typing it; Edit and Reject remain. A dictation's words, once the inbox sends them, are the client's claim, under the typed words' budget.
- **Pilot results files live outside Earshot** (new in v1.3). Once handed over, a file is the maintainer's to keep and delete as the consent says: after Phase 8's report, within 12 months, or on request. Earshot can't enforce that. The files hold no name, email, or address, but a participant's decisions and timings are still theirs. Whether `/pilot` may be hosted publicly, or runs only on the maintainer's laptop, is the maintainer's call; it's static and holds no data either way.
- **Rate limits key on IP**, so users behind one shared IP share a budget.
- **Nothing has run on real Neon or Cloudflare yet.** Unverified so far:
  - the role grant;
  - the pooled connection per request;
  - the database rate limiter and the presence of `cf-connecting-ip`;
  - email delivery;
  - passkeys on real devices, the step-up's fastest path included;
  - OAuth callbacks;
  - `SessionDO` hibernation, the Queue and its dead-letter queue on Workers Free, and per-PR queues;
  - the session socket through Cloudflare's edge, including the `Origin` check and the ticket subprotocol;
  - from v1.3: the whole review path from the tray through the flush to the inbox, which needs both Workers on one Postgres; whether 60 s of grace is enough for late usage and metrics on real networks, and whether the seal's alarm keeps `SessionDO` from hibernating; `sealSessions` over the service binding; and the audit chain's canonical text on Neon's Postgres.
- **The public workers.dev URLs** have no paid APIs behind them. Validation, minting, extraction, and the recap all use the user's own keys.
- **Queue messages carry transcripts.** Batches of events, transcript text included, and from v1.3 reviews with what the reviewer saw, recaps, and typed corrections, sit in the Queue until they're written, and refused batches sit in the dead-letter queue (24-hour retention on Workers Free, up to 14 days on Paid). Shorter retention, or encrypting batches, is a Phase 10 item.
- **The provider spike (Phase 3 WP1) hasn't run.** It needs the user's keys. Until then these are unverified:
  - that Deepgram accepts its grant from the browser through the `bearer` subprotocol;
  - AssemblyAI's exact token request and close codes;
  - whether Deepgram keeps keyterms in usage records unless `redact_usage` is set.
- **The second witness's live check (Phase 4 WP9) hasn't run** (new in v1.2). It needs the user's approval: ten turns, under $0.01. Until then, Groq's CORS on a real request, its confidence fields, and its latency are as documented, not observed.
- **The recap's live check (Phase 5 WP10) hasn't run** (new in v1.3). It needs the user's approval: one recap on each provider, under $0.01. Until then, whether Haiku 5.5 makes the forced call at its default effort, the recap's cost and drop rate on a real model, and both models' latency against the 15 s deadline are as documented, not observed.
- **AI Gateway's logging** is switched off per request with `cf-aig-collect-log: false`. The gateway's own setting still has to be checked on the first deploy.
- **Speech-to-text providers, and Groq when the second witness is on, see the audio** under their own terms. Earshot doesn't use Gemini's free tier, which trains on submitted data.

## What Phase 10 adds

Phase 10 replaces this document with a full threat model: STRIDE across the whole system, plus the OWASP Top 10 for LLM applications. It also adds:

- CSP headers, allowing `connect-src https://api.groq.com` for the second witness;
- dependency and secret scanning;
- a key-rotation drill, for the vault's master key and the audit signing key;
- retention flows;
- a privacy policy;
- EU AI Act notices.
