# Threat model (v1.2)

Version 1.2 covers everything up to the end of Phase 4:

- the repository and its pipeline, from v0;
- user accounts and sign-in;
- tenant data in Postgres;
- the session event log;
- AI key handling;
- data export and deletion;
- voice capture, short-lived provider credentials, the session socket and its Durable Object, the Queue flush, and LLM calls on the user's own key (from v1.1);
- the understanding pipeline, the second witness, and the CI smoke eval (new in v1.2): the model quotes names and a deterministic linker resolves them, the browser sends each turn's audio to Groq on the user's key, and an opt-in CI job calls a real model on a dedicated key.

Phase 6 adds CRM adapters. Each phase updates this document. Phase 10 replaces it with a full STRIDE model.

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

**Out of scope for v1.2**

- CRM credentials and adapters. These start in Phase 6. The vault already encrypts CRM connections the same way as AI keys, but nothing writes them yet. Proposals stay inside Earshot until then: nothing is written to a CRM.
- The Conversation engine (speech-to-speech). It was cut from Phase 3.

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
| Session tickets | Signed with `EARSHOT_SESSION_TICKET_SECRET` (both Workers), valid 60 s, usable once; they travel in `Sec-WebSocket-Protocol` |
| Minted speech-to-text credentials | An AssemblyAI token or a Deepgram grant, valid 30–60 s for opening a socket; handed to the browser, never stored |
| The LLM key, per turn | Sent from the device in that turn's `turn_end` message over TLS, used for one extraction, and never written down |
| Live session logs | Each `SessionDO`'s SQLite holds its session's events until Postgres confirms them, then for 24 hours |
| Queue messages | Batches of session events (transcript text included) on their way to Postgres; the dead-letter queue holds refused batches |
| Microphone audio | Streamed from the browser to the speech-to-text provider; with the second witness on, each turn's audio also goes from the browser to Groq. Never sent to Earshot's servers |
| Each turn's audio, for the second witness (new in v1.2) | The page's memory only: from the press to the release plus 200 ms, capped at 120 s, dropped once Groq has answered |
| Evidence clips: each turn's audio, kept to replay while reviewing (Phase 5 WP9, for v1.3) | The recording device only: IndexedDB `earshot-evidence`, one record per turn, AES-GCM under that database's own non-extractable key, each record bound to its id. Never played after 24 hours; deleted when Earshot next opens or comes back into view, before each write, at sign-out (everything, the key included), and when clips are turned off. Never sent anywhere (ADR-0036) |
| The Groq key, for the second witness (new in v1.2) | On the device with the other AI keys; decrypted in the page and sent straight to `api.groq.com` in an `Authorization` header, once per turn, never through Earshot. (A rep who also picks Groq for extraction sends the same key on `turn_end`, as in v1.1) |
| The second witness's transcripts (new in v1.2) | `utterance.final` events marked unbiased, in the session log, the Queue, and Postgres, like every other transcript |
| What the linker read for each turn (new in v1.2) | `SessionDO`'s SQLite (`turns`): the records and context a turn's targets were linked against, so a late witness is compared the same way. Deleted with the session's storage |
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

  Everything else runs inside `withTenant`, which switches to the `earshot_app` role and pins one workspace and user for the transaction.
- **Workspace to workspace.** Row-level security keys every tenant row to `app.workspace_id`.
- **Device to server, for AI keys.** A key leaves the device only in the `x-earshot-provider-key` header of a single request, over TLS. The server writes it down only if the user puts it in the vault.
- **Worker to third parties.** These include:
  - AI providers' key-validation endpoints;
  - Resend, for magic-link email;
  - GitHub and Google, for OAuth;
  - AssemblyAI and Deepgram, to mint short-lived credentials (web Worker);
  - Anthropic and Groq, for proposal extraction, optionally through Cloudflare AI Gateway with logging off (`SessionDO`).
- **Browser to speech-to-text provider.** Audio goes straight from the browser to the provider over TLS, opened with a credential that only works for a few seconds. Earshot's servers never see the audio.
- **Browser to Groq, for the second witness (new in v1.2).** Only after the rep says yes, once per device, and only with a Groq key on the device. Each turn's audio goes over TLS to `api.groq.com` with the rep's long-lived Groq key, because Groq has no short-lived credential to mint (ADR-0029 amends ADR-0002 and ADR-0021 for this). Groq's CORS allows the call from the page. On this path Earshot's servers see neither the audio nor the key; they get only the transcript, through the session socket.
- **CI to Anthropic, for the smoke eval (new in v1.2).** Off unless the repository variable `EVAL_SMOKE_ENABLED` is `true`. The key reaches only jobs in the `eval-smoke` environment, on `workflow_dispatch` or on pull requests from branches in this repository.
- **Browser to the edge Worker.** The session socket opens only with a valid ticket for that session and an allowed `Origin`. Cookies play no part, so another site can't ride a signed-in browser.
- **`SessionDO` to Postgres.** Events go through a Queue to a consumer that writes them with `withTenant`, as the session's own user and workspace.
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

### Voice sessions (new in v1.1)

| Threat | Mitigation now |
|---|---|
| A stolen session ticket | A ticket lives 60 s, names one session, and works once (its `jti` is remembered). The first connection pins the user and workspace, so a ticket for another user is refused (close 4007). Tickets are added to the logger's exact secrets. |
| Another site opening a session socket in a signed-in browser | The socket checks `Origin` against `WEB_ORIGIN` and needs the ticket in `Sec-WebSocket-Protocol`; it doesn't use cookies |
| A minted credential leaking the user's key | Credentials are minted server-side from the key in `x-earshot-provider-key`. The provider's response body is never forwarded, a credential containing any 8-character run of the key is refused, and minting is signed-in and rate-limited. Credentials live seconds and aren't stored. |
| A Deepgram grant or other credential reaching the session log | The session protocol refuses key- and JWT-shaped strings anywhere but `turn_end.key` and, from Phase 5 WP10, `end.recap.key` |
| The per-turn LLM key being kept | It rides only on `turn_end`, is held apart from the message in the client's in-memory outbox and dropped on the ack, and is used for that one call. Canary tests scan `SessionDO`'s SQLite, the Queue messages, socket frames, and logs for it. |
| Flooding a session | A token bucket (20 messages a second) closes the socket at the first message over the rate, so nothing after it runs out of order. Turns are capped at 30 per 10 minutes, capture at 30 minutes, messages at 64 KB, and utterance text at 4,000 characters. |
| Losing or reordering events on a bad network | Events are sequence-numbered and acknowledged; a reconnecting client resumes from its last seq, and resends are deduplicated by msgId. The Postgres flush is idempotent, and the log is append-only. |
| A transcript lingering after it should be gone | `SessionDO` deletes its storage 24 hours after Postgres confirms the whole log, and ends a session nobody ended once it's been idle past its limit. Deleting an account purges the Durable Object storage of its sessions first, and stops, deleting nothing, if that fails. |
| Prompt injection through what's said in a debrief | The model can only return proposals in a fixed schema, which are validated. Every field must quote words that appear in the transcript, or it's flagged and dropped. Nothing is written to a CRM in Phase 3, and Phase 5 puts a human review in front of every write. |
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
| The CI smoke key being stolen or overspent | The key lives only in the `eval-smoke` environment, which jobs reach only on `workflow_dispatch` or on pull requests from branches in this repository; fork PRs get no secrets. Only the steps that call the model see it, not `pnpm install`, and the workflow passes PR data to the shell through environment variables, never inline. The job is skipped unless `EVAL_SMOKE_ENABLED` is `true`. A budget guard refuses a run whose estimate (× 1.25) passes `EVAL_SMOKE_BUDGET_USD`, and stops one whose measured spend does, and the key comes from a separate Anthropic workspace with a monthly spend limit. The job reports numbers only, never prompts, transcripts, or response bodies. |

### Evidence clips (Phase 5 WP9, for v1.3)

| Threat | Mitigation now |
|---|---|
| Audio at rest on the device, read by anyone with the browser profile's files | Each clip is AES-GCM under a 256-bit key generated non-extractable and stored as a `CryptoKey`, in a database of its own (`earshot-evidence`), apart from the device keys' database and key. The ciphertext alone leaves the audio unreadable; the key can't be exported by script. |
| A clip moved or swapped into another debrief's place | The additional data is `earshot-clip:v1:<sessionId>:<turnId>`, built from where a record is stored, so a record moved to another id doesn't decrypt there, and the store deletes it. A record whose fields claim a session its id isn't in is ignored. Tests move records between turns and sessions. |
| A clip outliving 24 hours | Never played after 24 hours, whether or not it's been deleted yet: the store refuses an expired record, and every press reads the store. Deleted when Earshot opens or comes back into view, before each write, and at sign-out. No browser runs code at the 24-hour mark, so a device Earshot isn't opened on keeps expired, encrypted clips until it is (see Known gaps). |
| A clip reaching Earshot's servers or a third party | There's no path: the clip modules (`@earshot/voice/evidence`, `apps/web/lib/evidence`, `apps/web/components/evidence`) have no request, socket, cross-window message, server action, or log, which a test checks in their source; no route touches clips, which a test checks too; the session socket's messages are strict schemas with no field for audio. The fake-microphone e2e test records every body the page sends while a turn is kept and played: none reaches a second of audio. The second witness still sends each turn's audio to Groq, with consent, on the rep's key, unchanged (ADR-0029). |
| The next person on a shared device hearing the last rep's debriefs | The clip store belongs to one signed-in user (`earshot.evidence.owner` in localStorage, a user id). When the app opens for anyone else, or for a store with no recorded owner, every clip and the key are deleted before anything is kept, however the last session ended: signed out here, expired, or signed out from another device. A page keeps a clip only while its viewer still owns the store, so a tab left running a debrief after another user signs in keeps nothing more. Signing out from the account menu, or deleting the account, stops capture, deletes every clip and the key, and forgets the owner, which other tabs hear as a `storage` event; they stop playing, and keep nothing more. Turning clips off deletes them. An e2e signs a second user in after the first one's session ended without the menu, and finds no clip and no key. |
| Playback feeding back into a live debrief | While a clip plays, a hands-free engine takes no microphone audio, and pressing push-to-talk stops the clip, so a clip can't become a turn. |

### The recap (Phase 5 WP10, for v1.3)

| Threat | Mitigation now |
|---|---|
| The recap's key being kept | It rides only on `end`, at `end.recap.key`, the protocol's one key slot besides `turn_end.key`. The client's in-memory outbox holds it apart from the message until the ack, as it does a turn's key; `SessionDO` holds it in the recap call's closure for that one call, and never stores or logs it. Canary tests, Anthropic-shaped and plain, scan `SessionDO`'s SQLite, the Queue messages, socket frames, and logs for it. A key-shaped string anywhere else in `end` is refused. |
| A recap saying what the rep didn't (an invented commitment, a paraphrase that changes it, or prompt injection through what's said) | The model can only return sentences in a fixed schema, each with quotes. Code locates every quote in the session's own transcript and drops a sentence with none, and the recap says how many were dropped; a sentence that says more than its words is marked and shown with a note; a lens field whose quote isn't there is "not mentioned". Every kept sentence opens the words behind it. The $0 gate in `checks` holds that every seeded bad sentence and invented lens quote is dropped. Nothing in a recap is written to a CRM. |
| A recap holding the seal or the tray | Reviews don't wait on it. The seal does, for at most the recap's 15 s deadline; a failure or timeout is recorded as such and the seal goes on. A recap lost to a restart is recorded as failed when the session seals. |
| A recap's words reaching logs | `SessionDO` logs counts and codes only (outcome, reason, sentences, dropped, weak, lens, mentioned). The live smoke eval and the live check report numbers only. The recap itself is session data: it's flushed to Postgres with the log, into `sessions.recap`, under the same row-level security. |
| A key-shaped string in a recap | The checks drop a sentence shaped like a provider key, and the client refuses any server message carrying one. |

## Known gaps

- **Row-level security isn't a sandbox.** It catches app bugs, but code holding the connection, such as a successful SQL injection, could `RESET ROLE` or change `app.workspace_id`. The mitigation is that every query goes through Drizzle with parameters.
- **Inside a workspace, child tables trust every member.** `session_events`, `utterances`, `proposals`, and `sync_jobs` aren't bound to their session's user. Phase 2 has one member per workspace. Team workspaces will need per-member rules, decided when manager review is designed (ADR-0019).
- **XSS could use device keys.** An XSS on Earshot's origin could ask the browser to decrypt them, even though the wrapping key can't be exported. There is no Content-Security-Policy yet; it's planned for Phase 10. Until then, keep dependencies few and render all text as text. Since v1.2 the page also uses the Groq key itself, for the second witness, which adds no new exposure beyond this one. From Phase 5 (WP9, for v1.3), an XSS could also play or decrypt the evidence clips on the device, the last 24 hours of the rep's own words, through the same browser-held key; clips add no new kind of exposure, and they last a day.
- **Safari can delete device keys after a week away** (Phase 5, for v1.3).
  - **The rule:** Safari's 7-day rule deletes a site's script-writable storage, IndexedDB included, after seven days of Safari use without a visit to the site. A rep who uses Earshot in a Safari tab and skips a week loses the keys kept on that device.
  - **What Earshot does:** on iOS Safari, outside a Home Screen app, Settings → Keys says so and suggests the Home Screen. A Home Screen app keeps its own count of days, and its own storage apart from Safari's, so the keys have to be added again there.
  - **`persist()`:** Earshot also asks every browser once to keep its storage (`navigator.storage.persist()`), after the first key is stored on a device, or when evidence clips are turned on (the same request, remembered once). Chrome grants it silently from engagement, and Firefox asks. Safari grants it by heuristics, and the only one WebKit names is opening the site as a Home Screen app, so in a Safari tab it likely doesn't help.
- **Evidence clips can go early, and can outlive their 24 hours** (Phase 5 WP9, for v1.3).
  - **Early:** eviction under storage pressure takes a best-effort origin's storage all at once, clips with the keys, and iOS Lockdown Mode has no IndexedDB at all (not yet checked on a device). Safari's 7-day rule can't touch a 24-hour clip. Designed for: every card works without audio and says why ("No audio on this device", "This browser can't keep audio", and so on), and `persist()` protects clips as it protects keys.
  - **Late:** expired clips are deleted when Earshot next opens on the device, not at the 24-hour mark. They're encrypted and never played after it, but a device Earshot isn't opened on again keeps them.
  - **Sign-out elsewhere:** a session that expires, or is signed out from another device, leaves its clips encrypted in the browser until Earshot next opens there. Then they're deleted, whoever opens it, if the store isn't theirs, and otherwise they expire within 24 hours.
- **The Groq key is long-lived and used from the page** (new in v1.2). Groq offers no short-lived credential, so the second witness sends the rep's own key from the browser on every turn, unlike speech-to-text, whose credentials live seconds. ADR-0029 records the exception. A Groq key used only for Earshot keeps a leak contained.
- **Rate limits key on IP**, so users behind one shared IP share a budget.
- **Nothing has run on real Neon or Cloudflare yet.** Unverified so far:
  - the role grant;
  - the pooled connection per request;
  - the database rate limiter and the presence of `cf-connecting-ip`;
  - email delivery;
  - passkeys on real devices;
  - OAuth callbacks;
  - `SessionDO` hibernation, the Queue and its dead-letter queue on Workers Free, and per-PR queues;
  - the session socket through Cloudflare's edge, including the `Origin` check and the ticket subprotocol.
- **The public workers.dev URLs** have no paid APIs behind them. Validation, minting, and extraction all use the user's own keys.
- **Queue messages carry transcripts.** Batches of events, transcript text included, sit in the Queue until they're written, and refused batches sit in the dead-letter queue (24-hour retention on Workers Free, up to 14 days on Paid). Shorter retention, or encrypting batches, is a Phase 10 item.
- **The provider spike (Phase 3 WP1) hasn't run.** It needs the user's keys. Until then these are unverified:
  - that Deepgram accepts its grant from the browser through the `bearer` subprotocol;
  - AssemblyAI's exact token request and close codes;
  - whether Deepgram keeps keyterms in usage records unless `redact_usage` is set.
- **The second witness's live check (Phase 4 WP9) hasn't run** (new in v1.2). It needs the user's approval: ten turns, under $0.01. Until then, Groq's CORS on a real request, its confidence fields, and its latency are as documented, not observed.
- **AI Gateway's logging** is switched off per request with `cf-aig-collect-log: false`. The gateway's own setting still has to be checked on the first deploy.
- **Speech-to-text providers, and Groq when the second witness is on, see the audio** under their own terms. Earshot doesn't use Gemini's free tier, which trains on submitted data.

## What Phase 10 adds

Phase 10 replaces this document with a full threat model: STRIDE across the whole system, plus the OWASP Top 10 for LLM applications. It also adds:

- CSP headers, allowing `connect-src https://api.groq.com` for the second witness;
- dependency and secret scanning;
- a key-rotation drill;
- retention flows;
- a privacy policy;
- EU AI Act notices.
