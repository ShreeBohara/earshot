# ADR-0022: The voice engine interface, and thin hand-written speech-to-text clients

## Status

Accepted (2026-11-15), built in Phase 3 WP4 as `packages/voice`. The provider details marked "WP1" are written from the providers' docs and confirmed by the provider spike.

## Context and problem

ADR-0001 chose a cascaded engine by default (speech-to-text in the browser, an LLM in `SessionDO`) and ADR-0002 has the browser stream straight to the provider with a short-lived credential. Phase 3 needs the browser half: capture, resampling, the provider sockets, turn handling, reconnects, and a meter. It must run on iOS Safari, cost nothing in CI, and keep audio away from Earshot's servers.

## Considered options

- **Thin hand-written WebSocket clients behind one adapter interface (chosen).**
- The providers' SDKs: `@deepgram/sdk` 5.x and `assemblyai` 4.x.
- A Worker relay that carries all audio.

## Decision

- **Interfaces.** `VoiceEngine` (spec §4.1) emits `VoiceEvent`s: partials for the UI, finals and turn ends for `SessionDO`, levels, usage, state, and errors. Speech-to-text providers sit behind `SttAdapter` and `SttConnection`. The Debrief engine implements `VoiceEngine` now; the Conversation engine (WP12) can later.
- **Adapters.** AssemblyAI Universal-Streaming v3 is the default; Deepgram Nova-3 (`/v1/listen`) and Flux (`/v2/listen`) are the second. Each is a few hundred lines with no SDK: whether Deepgram's SDK presents grant JWTs correctly is unverified, and the clients are small.
  - Credentials come from `POST /api/voice/token` as `{ provider, credential, expiresAt, url }`, where `url` is a base the adapter extends with its path. AssemblyAI takes `?token=`; Deepgram takes the subprotocols `["bearer", jwt]` (community-verified; WP1). A fresh credential is minted for every connect. Adapters refuse another provider's credential, and any `ws:` URL off loopback.
  - Keyterms go at connect and mid-stream (`UpdateConfiguration`, `Configure`), cut to each provider's limits. Finals become `utterance.final` v2 on the session's audio clock, with word timings, mean confidence, and `witness: "biased"`.
- **Capture.** One microphone stream per armed session; push-to-talk gates sending, not capture. The `AudioContext` runs at the device's rate (a 16 kHz context loses samples on iOS), and the `pcm16-capture` worklet low-passes (flat to 6 kHz, 70 dB down from 8 kHz) and resamples to 16 kHz: 3:1 from 48 kHz, polyphase from 44.1 kHz and anything else. It posts 512-sample frames; adapters send 64 ms messages.
- **The speech stream is the session's audio clock.** Only gated audio enters it, its last 60 s stay in a ring buffer, and each socket sends from a cursor into it. A reconnect starts its cursor at the end of the last final, so replay and live audio are one code path, and no ended turn is ever re-sent.
- **The socket's lifecycle is a pure reducer** (`@earshot/voice/machines`): open on the first press, reuse across presses, keep alive, close after 20 s idle (AssemblyAI bills open sockets; its free tier allows 5 new streams a minute), reconnect with backoff only while audio is needed.
- **Assets.** Next.js can't bundle a worklet from a TypeScript source package, so `earshot-voice-assets` builds it into the web app's `public/voice/`, and copies hands-free's assets (Silero v6, vad-web's worklet, onnxruntime-web's wasm and glue) from `node_modules` into `public/vad/`. Nothing is fetched. onnxruntime-web is pinned at 1.31.1 and runs single-threaded, so no cross-origin isolation is needed.
- **Hands-free.** vad-web loads only when chosen. The provider's endpointing decides turns; the VAD drives the UI state and closes the socket after 20 s of silence.
- **Prices.** The dated price table is `@earshot/voice/prices`, which, like the machines, typechecks without the DOM, because the edge Worker imports both.
- **Later providers.** Speechmatics can't change its vocabulary mid-stream, and a large list can delay its start by up to 15 s. Gemini's transcription gives utterance-level timestamps only and no confidence, which `utterance.final` and proposal evidence need. Both wait.

## Consequences

- Good: no audio reaches Earshot; CI runs the whole pipeline at $0 with the fake adapter (`@earshot/voice/testing`), which WP11's fake-microphone eval drives.
- Good: a provider swap touches one adapter file; the engine, the meter, and `SessionDO` don't change.
- Bad: provider message formats are written from docs, not observed. WP1 confirms Deepgram's JWT transport on both paths, Flux's times and keepalive, AssemblyAI's model parameter and close codes, and whether providers take replayed audio faster than real time.
- Bad: the web app's dev and Worker builds run an asset step (about 16 MB copied, one small esbuild bundle).

## Amendment (2026-11-19, Phase 3 WP8): the client session runtime

WP8 adds the browser's half of the session socket (spec §4.2) to this package, as `@earshot/voice/session`, and the state machines v1 taught us we needed, as pure reducers in `@earshot/voice/machines`.

- **`SessionClient`.** Every connect fetches a fresh ticket (SessionDO accepts a `jti` once) and offers it as `["earshot.v1", "earshot.ticket.<ticket>"]`. It says `hello` with the last seq it folded and waits for `welcome`; a gap in seqs says `hello` again on the same socket, and the same gap four times running closes the connection as out of sync. A `ping` every 20 s, and a `welcome` that never comes, find dead sockets. Drops reconnect with full-jitter backoff (500 ms up to 15 s), as each close code's `reconnect` flag says; a refused ticket is replaced at once, and a second refusal in a row stops.
- **The outbox** keeps every state-changing message, with its UUIDv7 msgId, in memory until SessionDO acknowledges it, and resends what's unacknowledged, in order, on every new socket. A `turn_end` key is held apart from the message, spliced in only while a frame is serialized, and dropped on the ack, a final refusal, or `stop()`. Nothing persists it, IndexedDB included.
- **One fold everywhere.** Events are upcast and validated by `@earshot/events`' registry and folded with `defaultProjections`, the projections the server and Postgres use, into a `SessionStore` (`subscribe` and `getState`, for `useSyncExternalStore`). The demo fixture folds through it to exactly what `replay()` builds. An event type or version the client doesn't know, or one that breaks its schema, stops folding (the store says why) rather than diverging, while the outbox keeps delivering.
- **Pacing.** The client keeps its own send budget (burst 16, 10 a second) under SessionDO's token bucket (burst 20, 20 a second), because a refused message has no msgId and refusals are per message: a refused `utterance` followed by an accepted `turn_end` would run the turn without it.
- **The page.** `offline` parks reconnects until `online`. On iOS, a hidden page loses the microphone and soon its sockets, so the client calls the app's `onSuspend` (stop capture, so the last turn reaches the outbox), flushes, closes cleanly, and resumes when the page is visible.
- **Machines.** `capture` follows the Debrief engine's own states rather than modeling the speech socket again; `connection` drives `SessionClient`; `autoMute` is read through a synchronous ref (`createAutoMute`), never React state; `silentResponse` chimes only when audio output is safe (on iOS, with the mic track stopped); and `retry` holds the spec's targets (3 attempts in 8 s, `Retry-After` first), with `nextRetryDelay` matching `@earshot/agent`'s local copy so it can import this one. Each exports its states and events as `const` arrays, and a table test decides every pair.
- **Consequence.** `./machines` now imports `@earshot/core` (the close codes), so the no-DOM check adds a minimal WebCrypto and TextEncoder declaration, which Workers provide, and still proves it would catch a DOM reference.

