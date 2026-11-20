# ADR-0024: The session runtime: a SQLite-first SessionDO, acknowledged resume, and a Queue flush to Postgres

## Status

Accepted (2026-11-19). Phase 3 WP6 (the `SessionDO` runtime) and WP7 (the flush) build it together. The first deploy still has to check two things on real accounts: that a scripted session's Durable Object log equals its `session_events` rows (gate G2e), and the open questions under "More information". Amended 2026-11-20 by Phase 5 WP3: the seal, the `review` and `snooze` messages, refusals after the seal, cleanup after a sealed confirmation, audit rows at flush, and `sealSessions` (see "Phase 5: the seal", and ADR-0032).

## Context and problem

ADR-0003 gave each capture session its own Durable Object, and ADR-0020 built the event store it flushes into. Phase 3 needs the object itself:

- The browser talks to it over a WebSocket that must survive network drops, deploys, and hibernation without losing or repeating an event. The gate (G2) forces a drop mid-turn and requires the client's log and Postgres to agree.
- Each turn runs an LLM call with the user's own key, which must exist only for that call (ADR-0021).
- Every session needs a durable cost record and a latency record.
- Postgres must end up with exactly the object's log, though Queues deliver at least once and in any order.
- Durable Object storage becomes a second place transcripts live, so deletion has to reach it.

## Considered options

- **Where events are written first:** **the object's SQLite, then Postgres through a Queue (chosen)**; straight to Postgres from the object on every message; Postgres only, at session end.
- **How a client catches up:** **contiguous seqs, cumulative acks, and `hello { lastSeq }` replay (chosen)**; a full snapshot on every reconnect; no resume.
- **Where the turn's key lives:** **on each `turn_end`, used for that call (chosen)**; in the object's memory for the session (lost on hibernation, spec decision 2); in a socket attachment (where attachments live while the object sleeps is undocumented).
- **What travels in a Queue message:** **the events themselves, packed up to 64 KB (chosen)**; ids and ranges only, with the consumer reading each range back from the object (an extra object request per flush).

## Decision

### The socket

`GET /v1/sessions/:id/ws` on the edge Worker checks, in order: `Upgrade: websocket` (else 426); `Origin` in `WEB_ORIGIN` (else 403, so a cross-site page gets no socket at all); that the client offers `earshot.v1` (else close `unsupported_protocol`); and the ticket from `Sec-WebSocket-Protocol` (ADR-0023): its HMAC, version, lifetime, expiry, and that its `sid` is this path's (else close `ticket_refused`). The secret is `EARSHOT_SESSION_TICKET_SECRET`, trimmed as the web app trims it. Development (`DEPLOY_ENV=development`) falls back to the shared development secret; anywhere else a missing, short, or development secret fails closed with a 500 and a log line that names the variable, never its value.

The route then calls `SESSION.get(SESSION.idFromName(sid))` with a request it builds from scratch: `Upgrade` and the verified claims in one internal header, nothing the client sent. `SessionDO` pins `sid`, `uid`, and `wid` on the first connection and closes any later one for another user or workspace with `forbidden`; refuses a `jti` it has seen with `ticket_reused`; accepts with `acceptWebSocket` (an attachment of `connId`, `uid`, `wid`, `jti`, whether the client said hello, and its ack); closes every older socket with `replaced`, so one socket is live; and answers the handshake with `earshot.v1` alone. Refusals after the handshake are close codes because a browser can't read the status of a failed handshake. `ping` and `pong` are answered by `setWebSocketAutoResponse`, without waking the object.

### The log

SQLite holds `meta`, `events` (seq from 0, UUIDv7 ids, the object's clock as `ts`), `client_msgs`, `tickets`, and `utterances` (which turn each utterance belongs to, which `utterance.final` doesn't record). Tables appear with the first write, so an object that was never used, or was cleaned up, holds nothing. `meta` is read into memory when the object wakes; the constructor reruns after every hibernation and eviction.

Each state-changing client message is handled in one transaction: its events and its `client_msgs` row (the seq of its last event, and any error it was answered with). A resend gets the same answer and appends nothing. Every event is checked against `@earshot/events`' registry before it's written, and client text Postgres's `jsonb` couldn't store (U+0000, unpaired surrogates) is refused at the socket, so the log can never hold an event the flush would refuse forever. Each event goes out as `event` to every socket that has said `hello`, then the sender gets `ack { msgId, seq }`.

| Message | What `SessionDO` does |
|---|---|
| `hello` | `welcome { lastSeq }`, then every event after the client's `lastSeq`, in seq order, in one synchronous pass |
| `start` | `session.started`, once; keeps the entities, `startedAt` (the extraction's call time), and `timeZone`. A second `start` gets the first one's seq |
| `utterance` | `utterance.final` v2. The same `utteranceId` under a new msgId gets the first one's seq |
| `turn_end` | Extraction (below), then `proposal.created` for each proposal, `usage.recorded`, and `turn.completed` |
| `usage` | Prices it and appends `usage.recorded` (also after `end`: it's what the session cost) |
| `metric` | `turn.measured`, all four stages from the client's one clock, rounded and floored at 0 |
| `ack` | Records the client's cumulative ack on its socket |
| `end` | Waits for any running turn, appends `session.ended` with the meter's total, and flushes at once |

Refusals that a resend would get again (`not_started`, `already_ended`, `duration_limit`, an unsupported model) aren't recorded. `turn_limit` and turn outcomes are recorded, so a resend repeats them.

### Turns

`turn_end` runs `runTurn` from `@earshot/agent` (ADR-0025) with the turn's utterances, the session's entities, call time, and time zone, and the turn's key, which is passed to that call and referenced nowhere else: not SQLite, the attachment, a log, or a Queue message. Turns and `end` run one at a time, in arrival order. A resent `turn_end` while its call runs starts nothing; after an eviction mid-call, the resend runs it again, which doubles one call's cost, rarely. `runTurn` sends `working` (never logged) and returns the events to append in order; its `error` goes to the client, and only its `failure` (fixed codes) is logged. An unsupported model is refused as `bad_message`; if `runTurn` throws (a bug), the turn is answered `internal` and recorded, so a resend can't repeat a paid call in a loop.

### Limits (targets)

Twenty messages a second per socket, as a token bucket with a burst of 20: excess messages get `rate_limited` (retryable) and are dropped, and a client that stays over the rate is closed with `rate_limited` once refusals, draining at the same rate, pass 100. Thirty turns per 10 minutes (`turn_limit`). Thirty minutes of capture after `start` (`duration_limit`), by the object's clock: usage, metrics, and `end` are still taken after it. Close codes are 4000–4099 with reasons under 123 bytes.

### The cost meter

Client `usage` messages are priced by `priceStt` (the dated table in `@earshot/voice/prices`; a local copy of its speech-to-text rows until WP4 merges). A provider and model the table lacks is recorded at $0 with the table's date and logged, so its audio and socket time can be priced later. LLM usage arrives priced from `runTurn`. Each `usage.recorded` adds to `meta.meter` in the same transaction, so the totals always equal the log's sum; `session.ended.costUsd` carries the total.

### The flush

Events not yet handed to the Queue are packed into messages `{ v: 1, sessionId, userId, workspaceId, fromSeq, toSeq, events }` of at most 64 KB of JSON (Queues bill per 64 KB); an event over that travels alone, and one too big for any message travels as a range with no `events`, which the consumer reads back with `readRange`. A flush runs once 20 events wait or the oldest has waited 30 s, checked on each message, with one alarm at the end of each window instead of a timer that would block hibernation, and at once on `end`. `enqueued_seq` moves only after `sendBatch` resolves; a failed send keeps the range for the next window.

The consumer, `flushBatch` in `apps/edge/src/flush.ts`, applies each message in one `withTenant(userId, workspaceId)` transaction: `appendEvents(tx, sessionId, fromSeq - 1, events)`, then `rebuildProjections(tx, sessionId)`, then `confirmFlushed(toSeq)` on the object, then `ack`. Messages run in session and seq order within a batch; each is acked or retried on its own, with a delay of 10 s doubling to at most 300 s.

| Outcome | What the consumer does |
|---|---|
| Stale, and the stored ids match | An earlier delivery committed and its ack was lost: confirm and ack |
| Stale, the stored ids a prefix of the batch | Append the rest |
| Stale, the stored ids differ | A second writer: log an alert, retry until the DLQ |
| Gap | `readRange` the missing events from the object, append them and the batch |
| `UnknownSessionError` | Retry, then the DLQ (the web app writes the row first, so this is a bug or a deleted session) |
| The append or the rebuild refuses the batch | A bug in the batch: straight to `earshot-flush-dlq`, acked, no retry |
| Anything else | Retry |

One `createPoolDb` per batch, ended with `waitUntil` (ADR-0018). Without `DATABASE_URL` (zero-setup development) the consumer acks each batch and logs `flush skipped`. One Worker produces and consumes; each preview gets `earshot-flush-pr-N` and its DLQ, created before the edge Worker deploys and deleted with the PR, with the janitor as a backstop.

### Cleanup and deletion

After `end`, unconfirmed events are sent again at +1 h and +6 h, then daily. A day after Postgres confirms the whole log, an alarm calls `deleteAll()`. A session nobody ended (a closed tab) is ended by the object once it has been idle 30 minutes past both the capture limit and its last event, so it reaches the same cleanup. `purge()` deletes everything at once: it closes the socket with `session_ended`, cancels a running turn, deletes the storage, and leaves a tombstone that refuses connections for five minutes, longer than any ticket issued before the deletion lives; an alarm then deletes the tombstone. The web app reaches it through its `EDGE` service binding, `env.EDGE.purgeSessions(ids)` (at most 500 ids, lowercase UUIDs; a bad argument is answered, not thrown), an RPC method on the edge Worker's default entrypoint that HTTP can't reach.

### Phase 5: the seal (amended 2026-11-20, WP3)

From Phase 5 a session has two writers that never overlap (ADR-0032): `SessionDO` until it seals, then the web Worker in Postgres.

| Message | What `SessionDO` does |
|---|---|
| `review` | From `start` until the seal: skips reviews whose `reviewId` the log holds, completes the rest (`by`: the pinned user and the socket ticket's `am` and `sat`, or `auth: null` for a ticket without them; `syncEligibleAt`: its clock plus the undo window), checks them with `checkReviews` against the folded log, and appends `proposal.reviewed` v2, or refuses the message with `bad_message`. Refused with `internal` without a usable audit signing key |
| `snooze` | The same, with `checkSnooze`, as `proposal.snoozed`; no key needed |
| everything but `hello` and `ack`, after the seal | Refused with `sealed`, not retryable (a resend of a message answered before the seal gets its first answer) |

- **The seal.** `end` sets `seal_due_ms` 60 s ahead; each client write after it moves it 60 s past that write, capped at 30 minutes after `end`; a session ended for idling gets the same. The alarm appends `session.sealed` in the serial queue and flushes it at once. It's the last event the object writes. An object from before Phase 5 seals at its next alarm.
- **A flag after an approval** appends a `system` reopen in the witness's own transaction (ADR-0032, decision 15).
- **Cleanup** waits for Postgres to confirm a log that ends in `session.sealed`, then runs a day later. Re-sends after the end work as before, for whatever Postgres hasn't confirmed.
- **The flush** records an audit row for each review event an append writes, in the session's user's name, and one checkpoint (`request: "flush"`), in the append's transaction, after the rebuild; none on the "stale, the ids match" path. Without a usable `EARSHOT_AUDIT_SIGNING_KEY` (loaded by `src/config.ts`, development's committed key only under `DEPLOY_ENV=development`), a message carrying reviews is retried until the DLQ, and SessionDO's re-sends try again later.
- **`sealSessions(ids)`**, a second RPC on the default entrypoint for the web app's `EDGE` binding (at most 500 lowercase UUIDs, answered not thrown, like `purgeSessions`): each object's `sealNow()` answers `live`, `sealing`, `sealed`, or `gone`, for the inbox's repair path.
- **SQLite** gains `writes`: each review's and snooze's client-made id, with its seq and proposal. `meta` gains `seal_due_ms` and `sealed_seq`.

### Logs

The redacting logger from `@earshot/keys/server`, with message types, close and error codes, counts, and error class names only: never a payload, a key, a ticket, or a provider's message.

## Consequences

**Good**

- No event is lost or repeated across drops, hibernation, deploys, resends, or duplicate deliveries; workerd and PGlite tests cover each case.
- An idle session costs nothing: hibernation, auto-answered heartbeats, and no timers.
- The LLM call starts the moment `turn_end` arrives; it never waits for a flush.
- Postgres's projections never lag its log, and a batch that can't succeed goes to the DLQ at once instead of retrying.
- Transcripts leave Durable Object storage a day after Postgres has them, at once on deletion, and abandoned sessions don't keep them forever.

**Bad**

- A full projection rebuild per flush reads the whole log; long conversations will want incremental projections.
- Queue messages and the DLQ hold transcripts, for Queues' retention (a day on Free, four days on Paid).
- An eviction mid-call runs that call again on the resend, doubling its cost.
- One live socket per session: a second tab replaces the first.
- The web app must call `purgeSessions` before deleting sessions or accounts. Until it does, a deleted session's unconfirmed events stay in its object (they can never be confirmed).

## More information

- Phase 3 build spec, §4.2–§4.4, WP6, WP7, and gate G2; ADR-0003, ADR-0018, ADR-0020, ADR-0021, ADR-0023, ADR-0025.
- Code: `apps/edge/src/session-do.ts` (the object), `session/store.ts` (SQLite), `app.ts` (the route), `flush.ts` and `flush-message.ts` (the flush), `queue.ts` (the producer sink, the consumer's glue, and the purge fan-out). `src/e2e.ts` is the same Worker with `@earshot/agent`'s cassettes, for end-to-end runs (`pnpm --filter @earshot/edge dev:e2e`). It also serves `GET /v1/e2e/scenario` (`src/e2e-scenario.ts`): the session the cassettes were recorded for, which the capture screen's development-only fake mode replays, and whose presence tells that mode the e2e Worker is the one listening.
- Tests: `apps/edge/test/sessions` runs `SessionDO` over real WebSockets in workerd, in one runtime (`isolate: false`, one worker), with extraction answered from cassettes and the flush recorded; `test/queue.test.ts` checks the consumer's acks with `createMessageBatch`; `test/node/flush.test.ts` runs `flushBatch` against PGlite with every migration.
- Checked in tests: answering the handshake with `Sec-WebSocket-Protocol: earshot.v1` is all the runtime needs (spec Appendix B, question 25). workerd 1.20261110 under the test runtime doesn't answer a client's Close frame itself, despite `web_socket_auto_reply_to_close`, so `webSocketClose` completes the handshake.
- Open, for the first deploy: whether a pending alarm blocks hibernation; whether DLQs work on Workers Free; whether the CI token's template covers Queues; subrequest and CPU limits on Free (Workers Paid sidesteps them).
