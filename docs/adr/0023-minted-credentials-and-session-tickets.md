# ADR-0023: Provider credentials minted from per-request keys, and signed single-use session tickets for the edge socket

## Status

Accepted (2026-11-15). Phase 3 WP3 builds the web app's half: the session, ticket, and token routes in `apps/web`. The edge Worker's half, checking tickets before a socket opens and pinning them in `SessionDO`, follows in WP6. WP1's spike confirms the provider mint requests against the live APIs. Amended for Phase 5 (2026-11-25): tickets carry how and when the viewer signed in (`am`, `sat`), a ticket can be had for an ended session until it's sealed, and the ticket secret also signs each session's approval policy. See "Amendment: Phase 5" below.

## Context and problem

In Phase 3 the browser streams audio straight to AssemblyAI or Deepgram (ADR-0002), and talks to the session's Durable Object over a WebSocket on the edge Worker (ADR-0003). Both connections need credentials, and neither may cost the user their key:

- **Speech-to-text.** The browser can't hold a provider key on an open socket for minutes: the key would sit in the page, and in the provider's URL or subprotocol. Each provider can mint a short-lived credential from the key instead, but only through a server call made with the key. Keys stay on the device (ADR-0009, ADR-0021), so they travel with the request that needs them, once.
- **The session socket.** The edge Worker doesn't share the web app's session cookie: it's another origin, and Better Auth lives in the web Worker. Browsers can't set headers on a WebSocket, and a credential in the URL lands in logs. The socket needs a credential that says "this signed-in user, in this workspace, may open this session, now", that the edge can check without a database, and that can't be replayed.

## Considered options

- **The web app mints provider credentials from a key sent per request, and signs short-lived, single-use tickets that the browser presents as a WebSocket subprotocol (chosen).**
- Relay all audio through the edge Worker with the key held server-side: a Durable Object relay bills duration for the whole session, and the server would hold keys (decision 7 of the Phase 3 spec).
- Store keys in the vault and mint from there: opt-in only, by ADR-0021.
- Tickets in the socket's query string: simplest, but URLs reach logs and history.
- Have the edge Worker read the web app's session cookie: a different origin, and Better Auth would have to run in two Workers.

## Decision

### Session tickets

A ticket is `payload.signature`: base64url JSON claims `{ v: 1, sid, uid, wid, jti, iat, exp }` and an HMAC-SHA256 over the payload with `EARSHOT_SESSION_TICKET_SECRET`. `signTicket` and `verifyTicket` in `@earshot/core` implement it with WebCrypto, comparing in constant time. A ticket lives 60 seconds, plus 5 seconds of clock skew either way, and carries a fresh UUIDv7 `jti`.

- **Issuing** (`apps/web/lib/voice/tickets.ts`). The web app signs one ticket per connection: the first with the session (`POST /api/sessions`), and a fresh one for every reconnect (`POST /api/sessions/:id/ticket`). It signs only for a session that is the viewer's own (`sessions.user_id` is the viewer), in the viewer's workspace (row-level security), and still open (`ended_at` is null). Another member's session answers 404, like one that doesn't exist.
- **Presenting.** The browser opens `new WebSocket(edgeUrl, ["earshot.v1", "earshot.ticket.<ticket>"])`, where `edgeUrl` is `wss://<edge>/v1/sessions/<sid>/ws`. Base64url characters and `.` are legal in a subprotocol token. The ticket never appears in a URL.
- **Checking** (WP6). The edge Worker checks `Origin`, the HMAC, the expiry, and that `sid` matches the path, then forwards to the session's Durable Object, which pins `uid` and `wid` on the first connection and refuses a `jti` it has seen. It answers the handshake with `earshot.v1` alone, so the ticket isn't echoed.

### Minting speech-to-text credentials

`POST /api/voice/token` takes the provider in `x-earshot-provider`, the key in `x-earshot-provider-key`, and `{ sessionId }` in the body. A key in the body or the URL is refused: the body is checked strictly, and the route takes no query string. The session must be one of the viewer's open sessions, so minting needs a live session as well as a sign-in. The route makes one request to the provider, with a 10-second timeout (`apps/web/lib/voice/mint.ts`):

| Provider | Request | Credential |
|---|---|---|
| AssemblyAI | `POST https://token.assemblyai.com/v1/token`, `Authorization: <key>`, `{ product: "streaming", expires_in_seconds: 60, max_session_duration_seconds: 1800 }` | `token`, good for opening sessions for 60 s; each session lasts at most 30 minutes |
| Deepgram | `POST https://api.deepgram.com/v1/auth/grant`, `Authorization: Token <key>`, `{ ttl_seconds: 30 }` | `access_token`, a JWT that only has to be valid at the handshake |

The answer is `{ provider, credential, expiresAt, url }`. `url` is the base the browser's adapter appends its own path and query to: the provider's WebSocket origin (`wss://streaming.assemblyai.com`, `wss://api.deepgram.com`), or a relay's base URL if WP1 finds Deepgram needs one. A provider that states a shorter life than requested sets `expiresAt`; a longer one changes nothing.

Nothing else the provider sent goes anywhere. An error answer's body is released unread, as `validateKey` does, because providers quote keys in errors. A success yields the credential and nothing more, and a credential holding any eight characters of the key in a row is refused. Failures map to the key routes' fixed codes: `rejected` (401 or 403, answered 422), `rate_limited` (429, answered 503), `upstream_error` (any other status, or no usable credential, answered 502), and `unreachable` (no answer in 10 s, answered 504).

### Starting a session

`POST /api/sessions` takes `{ mode: "debrief", engine: "cascaded", providers: { speechToText, llm }, selectedAccountId? }`. Provider and model ids must be plain ids: nothing shaped like a key, and no 24-character run of letters and digits mixed, which is what an unshaped key pasted into the wrong field looks like. In one tenant transaction (`withViewerTenant`), it writes the `sessions` row, which the event store needs before it takes the session's events, reads the workspace's CRM mirror, and signs the first ticket. It answers 201 with `{ sessionId, ticket, ticketExpiresAt, edgeUrl, entities, keyterms: { assemblyai, deepgram } }`.

- **Ranking** (`lib/voice/keyterms.ts`). The selected account, its contacts, and its deals come first, then the other companies, most recently updated first. A contact or deal belongs to the account when it comes from the same CRM connection and its `properties.companyId` is the account's source id (the external id, without the demo CRM's `demo:` prefix). A selection that isn't a company in the workspace is ignored.
- **Keyterms** come from that order: each record's name, then its aliases, normalized to NFC with single spaces, deduplicated ignoring case. AssemblyAI gets at most 100 terms of at most 50 characters. Deepgram gets at most 50 terms of at most 50 characters, within 500 tokens by a conservative estimate (a token per two bytes of UTF-8, plus one per term), since Deepgram doesn't document how it counts. A term that doesn't fit is skipped, and smaller ones after it can still fill the list. Calendar attendees and recent mentions join in Phase 7.
- **Entities** (`lib/voice/entities.ts`) are what extraction links proposals to and the transcript underlines: the same order, then the remaining contacts and deals. The client sends them back unchanged in `start`, which may carry 250 entities and 64 KiB, so the list is budgeted by its serialized size: 64 KiB less the rest of the message as the client will write it, with the providers it named, less 512 bytes of slack. With long names or many aliases the byte cap binds before the count. A record the socket would refuse (a name over 200 characters, anything shaped like a key) is left out, as are its unusable aliases.

### Limits

Counted in Postgres by `consumeRateLimit`, on counters separate from the key checks', and off under `next dev`:

| Route | Counter | Limit (targets) |
|---|---|---|
| `POST /api/sessions` | `session-create\|user:<id>` | 20 per 10 minutes |
| `POST /api/sessions/:id/ticket` | `session-ticket\|user:<id>` | 120 per 10 minutes |
| `POST /api/voice/token` | `voice-token\|user:<id>` and `voice-token\|ip:<cf-connecting-ip>` | 60 and 120 per 10 minutes |

The ticket limit isn't in the spec: a reconnecting client needs a ticket per attempt, so it's generous, but a ticket is a credential, so there is one. Requests refused as malformed aren't counted. Every route refuses cross-site and same-site requests with 403, by the key routes' `sec-fetch-site` rule, and answers `cache-control: no-store`.

### Keeping secrets out of logs, responses, and tables

- **Patterns.** `SECRET_PATTERNS` in `@earshot/keys` and `KEY_SHAPES` in `@earshot/core` gain OpenAI ephemeral keys (`ek_…`) and JWT-shaped strings (`eyJ…`, three dot-separated parts). The protocol therefore also refuses a Deepgram grant sent to `SessionDO`.
- **Exact secrets.** AssemblyAI and Deepgram keys have no fixed prefix, and a ticket has two parts, not three. Each request wraps the app's logger in `requestLogger` (`lib/log.ts`) and adds the key the moment it reads the header, the credential the moment it's minted, and each ticket the moment it's signed. Log lines carry codes and counts, so this is the second line of defense. `secretValues` adds `EARSHOT_SESSION_TICKET_SECRET` to what the app's logger redacts.
- **Tests** (`apps/web/test/voice-routes.test.ts`, on PGlite with fake providers that quote the key and the credential in their bodies and headers). No eight characters in a row of a key reach a response, a log line, a `console` call, or any column of any table, read as the owner. Credentials and tickets reach responses only in their own fields: the leak check blanks the `credential` and `ticket` fields and requires that nothing of either remains. Tickets verify with `verifyTicket` and name the right session, user, and workspace. Planted leaks (a key logged, a credential in `url`, a credential written to the session's row, a key in a counter's name, the provider's body forwarded) each fail the suite.

### Configuration

| Variable | Outside development | Under `next dev` |
|---|---|---|
| `EARSHOT_SESSION_TICKET_SECRET` | Required, at least 32 bytes; the development-only value is refused (`isDevTicketSecret`). The same value goes on both Workers. | `DEV_SESSION_TICKET_SECRET` from `@earshot/core`, which the edge Worker also falls back to |
| `EDGE_PUBLIC_URL` | Required: the edge Worker's origin, https unless localhost, no path. `render-wrangler.ts` sets it per target. | `EDGE_DEV_URL`, then `http://localhost:8787` |

Surrounding whitespace is trimmed from the secret, and the edge Worker must trim the same way. A missing or unsafe value fails closed: the session routes answer 500 and the log names the variable and the fix, never the value, and no session row is written. The token route needs neither. Deploys pass the secret to the web Worker through the CI secrets file, from the GitHub environment secret of the same name; the edge Worker gets it with its socket route.

## Consequences

**Good**

- A provider key exists on the server only for the length of one mint request, and nothing it touches keeps it.
- The browser holds credentials that expire in 30 to 60 seconds, and an AssemblyAI token's sessions end after 30 minutes.
- The edge checks a ticket with one HMAC and no database, and the Durable Object makes each one single-use.
- Tickets stay out of URLs, browser history, and access logs.
- The entities a session starts with always fit the message that carries them, whatever the CRM holds.

**Bad**

- Minting is still an oracle for stolen speech keys. Sign-in, a live session of the caller's own, the limits, and the cross-site refusal narrow it; the threat model records it.
- An AssemblyAI token can open more than one session within its 60 seconds.
- A stolen ticket works until its first use or 65 seconds, whichever comes first, because the web app doesn't track `jti`s; `SessionDO` does.
- One secret spans two Workers. Rotating it means deploying both, and tickets signed with the old one fail for up to a minute; clients then fetch fresh ones.
- Every mint costs one or two rate-limit upserts and a tenant transaction, and the per-IP limit is shared by everyone behind one address.
- The keyterm token estimate is a guess until WP1 measures Deepgram, and the entity list is a snapshot from the session's start.
- `SessionDO` receives the entity list from the client, so it must treat it as untrusted. A proposal's target outside the workspace is already stored as null by the projection.

## Amendment: Phase 5 (2026-11-25)

Phase 5's reviews come over the socket as well as through the web app, and each has to say how its reviewer signed in (ADR-0032, ADR-0033).

- **Two optional claims, still version 1.** `am` is how the web session that asked for the ticket signed in (`passkey`, `magic_link`, `github`, `google`, or `unknown`; ADR-0006's Phase 5 amendment), and `sat` is when, in whole Unix seconds. They come together or not at all, and `sat` can't be later than the ticket's `iat` plus the clock skew, which also catches milliseconds. They're written after `exp`, so a ticket without them signs to exactly the bytes it did before, and an old web app's tickets still open sockets on the new edge. Tickets stay within 1,024 characters.
- **Issuing.** `POST /api/sessions` and `/ticket` sign each ticket with the viewer's `signInMethod` (`unknown` for sign-in sessions from before migration 0013) and the session's `createdAt` in whole seconds; a sign-in time ahead of the route's clock is claimed at the ticket's own time, so two clocks can't fail a ticket.
- **Using them.** `SessionDO` records the socket's `am` and `sat` as each tray review's `by.auth`. A ticket without them, from a web app older than the edge during a deploy, records `by.auth: null`: unknown, not unauthenticated, since the ticket itself proves a signed-in user asked for it.
- **Tickets after `end`.** `/ticket` now answers for an ended session until it's sealed, since the tray still reviews over the socket in the seal's grace; a sealed session answers 409. `/api/voice/token` still refuses an ended session: capture is over.
- **A second use of the ticket secret.** `POST /api/sessions` signs the workspace's approval policy into each session with `EARSHOT_SESSION_TICKET_SECRET` (ADR-0034): HMAC-SHA256 over `"earshot.policy.v1."` and the canonical policy with the session's id, which `SessionDO` verifies on `start`. The prefix keeps the two uses apart: a ticket's HMAC covers base64url text, which never holds the prefix's dots, and a test shows a ticket's signature doesn't pass for a snapshot's. A policy can't ride in the ticket itself: it would pass the 1,024 characters.
- **Tests.** `packages/core/test/session-ticket.test.ts` holds tickets with and without `am` and `sat`, and refuses one without the other, a method that isn't one, or a `sat` after `iat` plus the skew; `apps/edge/test/sessions/reviews.test.ts` records the claims as a socket review's `by.auth`, and `auth: null` for a ticket without them.

## More information

- Phase 3 build spec, §4.3 (tickets) and WP3; WP1 confirms the mint requests, including whether AssemblyAI's body also needs `product: "streaming"`.
- `packages/core/src/session-ticket.ts`: the ticket format, `signTicket`, `verifyTicket`, and the development-only secret.
- `apps/web/lib/voice/`: `routes.ts` (the three routes' logic), `tickets.ts`, `mint.ts`, `keyterms.ts`, `entities.ts`, `config.ts`, and `types.ts` (the answers' shapes, for the browser's session client and adapters).
- ADR-0021 (key handling), ADR-0002 (browser-direct audio), ADR-0003 (one Durable Object per session).
