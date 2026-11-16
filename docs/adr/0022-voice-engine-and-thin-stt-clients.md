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
