# v1 retrospective

v1 was a hackathon build. This is a short, honest record of what it was, what is worth keeping, what was wrong when it was frozen, and how v2 answers each lesson.

v1 is frozen at tag `v1.0-hackathon` (commit `5b731bd`) and on branch `v1`. That commit includes PR #5, a Vitest regression harness for v1's tools and stores. To run v1, check out the tag or the branch.

## What v1 was

- A Next.js 16 app where a rep talked to an OpenAI Realtime agent (gpt-realtime over WebRTC) during a call.
- Seven Zod-typed tools ran in the browser against in-memory stores.
- The UI showed a voice orb, a live transcript, tool cards, a divergence chip, and a post-call summary.
- A Vitest regression harness for the tools and stores came last, in PR #5 (merged 2026-10-29).

## Worth keeping

Each of these comes back, rebuilt, in Phase 3 or 4:

- Synchronous, ref-based auto-mute while the agent speaks.
- Retrying after rate-limit responses, plus a fallback chime when the agent goes silent after a tool call.
- The divergence chip, which grows into conflict pills and two witnesses.
- Typed tool contracts with structured error codes (`duplicate_likely`, `unknown_customer`, and others).
- PR #5's regression tests. Their tool and store cases can seed Phase 4's eval fixtures.

## Known defects at the freeze

1. `connect()` in `app/page.tsx` resets status, error, and summary but never clears `toolCalls`. A second call's summary therefore includes the first call's tool calls.
2. `/api/session` and `/api/summarize` had no auth, so anyone could start sessions billed to the maintainer's key. Taking the key offline fixed this.
3. `/api/summarize` returns the model's JSON without validating it, and `components/earshot/call-log-view.tsx:219` crashes on an unexpected confidence value.
4. The system prompt lists every customer name (`app/lib/agent.ts:142`). That doesn't scale, and it biases the model toward known names. This observation led to the two-witnesses idea.
5. Undo in the tool toasts changes the stores directly instead of going through the tools.
6. The agent-audio hook (`app/hooks/use-agent-amplitude.ts`) was never wired in, so the orb reacted only to the mic. `status-badge.tsx` and `customer-picker-card.tsx` are unused.
7. `OpenAIRealtimeWebRTC` is created without an `audioElement`.
8. "Send to CRM" on the post-call card is a stub (`post-call-summary-card.tsx:58`).
9. Customer matching used word overlap (Jaccard similarity of 0.65 or more), which scores sound-alikes like "Atmas" and "Atlas" near zero.

## How v2 answers each lesson

| v1 | v2 |
|---|---|
| Tools ran in the browser | The agent runs in a Durable Object ([ADR-0003](adr/0003-durable-object-per-session.md)) |
| A hosted key behind open routes | Users bring their own keys, which stay on their device ([ADR-0009](adr/0009-ai-keys-stay-on-the-device.md)) |
| Speech-to-speech only | A cascaded engine by default, with vocabulary biasing ([ADR-0001](adr/0001-two-voice-engines-cascaded-by-default.md)) |
| Every customer name in the prompt | Retrieved shortlists, plus an unbiased second transcript |
| Word-overlap matching | A two-stage linker that abstains when unsure |
| A late unit-test harness (PR #5), but no evals or end-to-end tests | Evals first, CI gates, and replayable sessions ([ADR-0004](adr/0004-event-sourcing-for-sessions.md), [ADR-0014](adr/0014-evals-first-with-ci-gates.md)) |

The decision to freeze v1 and build v2 on `main` is recorded in [ADR-0016](adr/0016-main-is-v2-v1-frozen.md).
