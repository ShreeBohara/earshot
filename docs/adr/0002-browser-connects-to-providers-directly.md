# ADR-0002: The browser connects to providers directly, using short-lived tokens

## Status

Accepted (2026-11-15). Amended for Phase 4 (2026-11-20) by ADR-0029: with the rep's consent, audio also goes browser-direct to a second provider, on a long-lived key. See "Amendment: Phase 4" below.

## Context and problem

Live audio has to reach a speech provider with low latency. A media server in the path would be one more thing to pay for, run, and keep up. Earshot's hosting target is about $6 a month.

## Considered options

- **The browser connects directly, with short-lived tokens minted by the Worker.**
- LiveKit or Pipecat Cloud as a media server: a free tier, then $50+ a month, and about $800 a month at 1,000 users.

## Decision

The browser streams audio straight to the speech provider using a temporary credential. The server mints that credential from the user's own key, so no media server exists.

Not every provider is known to accept browser-direct temporary credentials. OpenAI and Gemini do; Deepgram and AssemblyAI need checking. A spike at the start of Phase 3 settles this. Where a provider doesn't accept them, the Worker relays the audio socket. That is cheap, because Workers bill a WebSocket upgrade as one request, not one per message.

## Consequences

**Good**

- No media server to pay for or operate.
- Lower latency, since audio takes one hop.
- Fits the BYOK model in ADR-0009.

**Bad**

- Token minting becomes a security surface. It needs rate limits, which arrive with minting in Phase 3. Until then, previews expose no paid APIs.
- Provider support is uneven, so some providers may need the relay.
- The browser has more responsibility for capture and reconnects.

## Amendment: Phase 4 (2026-11-20)

The second witness (ADR-0029) adds a second audio path. Still no media server, and Earshot's servers still see no audio:

- **A second provider, browser-direct.** With the rep's consent, asked once per device, each turn's audio also goes from the browser to Groq's Whisper, which transcribes it without the keyterm bias. Only the transcript reaches Earshot, through the session socket.
- **Batches, not a stream.** The page posts one WAV per turn once the turn ends: from the press to the release plus 200 ms, or, hands-free, the audio since the last turn, capped at 120 s.
- **A long-lived key, not a minted one.** Groq has no short-lived credential, so the page sends the rep's own Groq key in an `Authorization` header on each request, which Groq's CORS allows. This is the one exception to the short-lived tokens in this ADR's title. On this path the key never goes through Earshot (ADR-0021's Phase 4 amendment), and threat model v1.2 covers the exposure: an XSS could use it, as it could the other device keys.
- **A future Content Security Policy** must allow `connect-src https://api.groq.com`.

## More information

Phase 1 has no voice code. Public preview URLs have no paid APIs behind them.
