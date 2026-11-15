# ADR-0003: One Durable Object per session, in a Worker separate from the web app

## Status

Accepted (2026-11-15)

## Context and problem

v1 ran its tools in the browser. A session needs durable state, a server-side agent loop, and a WebSocket that stays open cheaply between messages. Deploying a Worker restarts its Durable Objects, so shipping the web app must not drop live sessions.

## Considered options

- **A Cloudflare Durable Object per session (`SessionDO`), in its own Worker.**
- Tools running in the browser, as in v1.
- Vercel functions, where WebSockets are capped at 300 s on Hobby.

## Decision

Each session gets its own `SessionDO`. It checks auth, holds the WebSocket with hibernation, sends sequence-numbered and acknowledged events so a reconnecting client loses nothing, runs the agent loop and per-user rate limits, and writes every event to its local SQLite before flushing to Postgres through a Queue.

The Durable Objects live in `apps/edge`, a Hono Worker deployed separately from `apps/web`. Web deploys then never restart live sessions. Durable Objects are included in the $5 Workers plan, and the free plan includes SQLite-backed ones.

## Consequences

**Good**

- State is durable per session, and tools run on the server.
- Web and edge deploy independently.
- Deterministic replay becomes possible (ADR-0004).

**Bad**

- Two Workers to deploy and keep versioned together.
- Preview Workers that define Durable Objects don't get Cloudflare's version preview URLs, which led to ADR-0017.
- Cloudflare-specific design, so self-hosting needs workerd.

## More information

Phase 1 ships only a skeleton: `/health` calls a `ping()` method that counts calls in the object's SQLite table. The real `SessionDO` arrives in Phase 3.
