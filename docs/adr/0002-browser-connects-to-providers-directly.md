# ADR-0002: The browser connects to providers directly, using short-lived tokens

## Status

Accepted (2026-11-15)

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

## More information

Phase 1 has no voice code. Public preview URLs have no paid APIs behind them.
