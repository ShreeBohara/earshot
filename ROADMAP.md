# Roadmap

Earshot v2 is a rebuild in ten phases. Each phase ships something that can be demoed and ends with a pass/fail gate. Targets such as latency and error rates are goals, not results.

**Current status (2026-11-20):** Phases 1–4 are built and merged, and Phase 5 is next. Nothing is deployed yet, and the checks that need live providers wait on the maintainer's keys. Each phase's status note says what shipped, what moved, and what's still to run.

The core loop is **capture, understand, verify, sync, remember**. The design principles behind it are in the README, and the decisions are in [docs/adr](docs/adr/README.md).

## Phase 1: Reset and foundations (weeks 1-2)

**Goal.** Archive v1 honestly and stand up the new repository, CI, design system, and decision records.

**What ships**
- v1 frozen at tag `v1.0-hackathon` and on branch `v1`.
- A pnpm and Turborepo monorepo: `apps/web`, `apps/edge`, `apps/docs`, `packages/{core,db,tokens,ui,tsconfig}`, and a Python `lab/` managed with uv.
- Contracts: Zod schemas exported as JSON Schema, which generates Pydantic models for the lab.
- CI on every pull request, and a full per-PR environment: web and edge Workers plus a Neon database branch.
- Design system v0: tokens, a three-input OKLCH theme generator, ten components, and Storybook.
- Decision records, CONTRIBUTING, SECURITY, a first threat model, and a v1 retrospective.

**Gate**
- CI is green.
- A PR spins up the web app, the edge Worker, and its own database branch.
- Storybook is published with the tokens and core components.

**Status:** built. The Fumadocs site (`apps/docs`) was cut. Per-PR environments, deploys, and the published Storybook wait on the Cloudflare, Neon, and Chromatic accounts and their secrets.

## Phase 2: Event-sourced core, auth, and data (weeks 3-5)

**Goal.** The backbone everything writes to: users, encrypted keys, a replayable event log, and tenant isolation you can prove.

**What ships**
- The domain model and Postgres schema, with pgvector and pg_trgm.
- Row-level security tied to each transaction's user, with pgTAP tests.
- An event store with per-session sequence numbers, schema versions with upcasters, projections, a replay engine, and JSONL export and import.
- Better Auth: magic links, passkeys, GitHub and Google sign-in, data export, and account deletion.
- Key handling: AI keys on the device by default, an optional encrypted server vault, and envelope encryption for CRM credentials.
- A demo CRM of about 60 accounts with deliberately confusable names.

**Gate**
- The isolation tests pass in CI: one user sees none of another user's data.
- Replaying a session file rebuilds identical projections.
- Tests show that no response or log contains a key, and that the server never stores an AI key unless the vault is on.

**Status:** built; the gate's tests run in CI. Real Neon and Cloudflare are unverified until the first deploy.

## Phase 3: Voice engine v2 and the capture experience (weeks 6-8)

**Goal.** A debrief that feels instant, costs about a cent, and never loses a word.

**What ships**
- A spike on which providers accept browser-direct temporary credentials.
- A `VoiceEngine` interface with the Debrief (cascaded) and Conversation (speech-to-speech) engines, token minting, and CRM keyterms per session.
- `SessionDO` with WebSocket hibernation, acknowledged events that resume after a reconnect, the agent loop, a per-session cost meter, and a Queue that flushes events to Postgres.
- Push-to-talk by default, hands-free optional, and Silero VAD in the browser.
- Eval harness v0: 30 synthetic debriefs played through the real app with a fake microphone.
- The capture screen, with the rebuilt orb, live transcript, activity feed, and proposal tray.
- A public replay demo at `/demo` that needs no key.

**Gate**
- On the Debrief engine, the 95th-percentile time from end of speech to proposal card is under 2.5 seconds.
- A forced network drop loses no events.
- The fake-microphone end-to-end test runs in CI.

**Status:** built, except the Conversation engine (speech-to-speech), which was cut. The fake-microphone eval and the network-drop test run in CI. The provider spike and the latency gate need the maintainer's keys (about $1), and the release waits on a deploy.

**Release:** v2.0-alpha.

## Phase 4: Understanding: proposals, entity linking, two witnesses (weeks 9-11)

**Goal.** Every utterance becomes typed, linked, evidence-backed proposals, and Earshot knows when it might be wrong.

**What ships**
- Proposal schema v2: notes, tasks, contacts, deal updates, meetings, commitments, and follow-up drafts, with evidence and risk flags on every field.
- Agent tools: write tools that only create proposals, read tools, and `ask_followup`. Methodology lenses (MEDDIC, SPICED, BANT) are configuration.
- Entity linker v1: aliases, Double Metaphone, trigram similarity, embeddings, and context, with calibrated scores and abstention.
- Two witnesses v1: an unbiased parallel transcript and conflict detection across both.
- Normalizers for dates, amounts, and negation, and a faithfulness check.
- Eval harness v1: 200 synthetic debriefs and a CI smoke eval that blocks regressions of more than 3 points.

**Gate**
- On the confusable-name set, the wrong-account rate is at most 2% while still deciding at least 85% of cases.
- Every proposal field carries evidence.
- The CI eval gate is live.

**Status:** built. On the confusable-name set's test split, linker v1 with the second witness decides 86.9% of mentions with a 0.6% wrong-account rate (gate G1a). The $0 gates run in CI's required `checks` job. What moved and what's still to run:
- Moved to Phase 5: `ask_followup`, follow-up drafts, and the methodology lenses (spec WP14, cut first).
- Moved to Phase 6: embeddings and Postgres search, with the mirror's sync (spec WP13, cut second). The linker uses aliases, sound, trigrams, and context.
- The regression gate on all 200 debriefs runs at $0 on offline cassettes. The live smoke eval on a real model is built but off until the maintainer adds its key.
- Waiting on the maintainer: the live smoke eval's baseline (about $0.15), the second witness's live check (under $0.01), and confusion mining on real speech-to-text (under $0.50).

## Phase 5: The trust layer: review inbox and approval policies (weeks 12-13)

**Goal.** Checking five CRM changes takes seconds, not minutes.

**What ships**
- The review inbox: diff cards, evidence threads, on-device audio clips, conflict pills, risk badges, inline edit, and accept, reject, snooze, or reply.
- Likely-edit highlighting v1, kept sparse.
- First-person uncertainty in the agent's voice.
- Approval policies by type and field, signed approvals, and an audit trail.
- A post-call recap in which every sentence is cited.

**Gate**
- In a 5-person pilot, the median review time per proposal is under 4 seconds.
- At least 90% of seeded wrong-account errors are caught.
- The inbox passes axe and a manual screen-reader check.

## Phase 6: Real CRM sync (weeks 14-16)

**Goal.** Approved changes land in real CRMs exactly once, with the right associations.

**What ships**
- An adapter SDK with a conformance suite, capability flags, an error taxonomy, per-connection rate limiters, a field-mapping UI, and a dry run that shows exact API payloads.
- An outbox on Cloudflare Workflows with idempotency keys, backoff, dead letters, and 3-way conflict detection.
- Adapters for Twenty (the reference), HubSpot, and Attio.
- A CRM mirror for entity linking, synced incrementally.

**Gate**
- Debrief, review, and approve lands correctly in a HubSpot test account and in Twenty.
- A chaos test with injected failures creates zero duplicates.
- All three adapters pass the conformance suite.

**Release:** v2.0-beta, invite-only.

## Phase 7: Memory, commitments, and briefs (weeks 17-19)

**Goal.** Past calls make the next one better.

**What ships**
- Account timelines and facts stored with the dates they held, with hybrid search and cited answers.
- A commitment ledger with resolved due dates, status, and overdue nudges.
- Pre-call briefs from calendar context (an ICS feed or your own OAuth client) with citations.
- Debrief nudges and a daily digest.
- A memory eval of about 200 questions.

**Gate**
- Cited answers are at least 95% faithful on the question set.
- Briefs render in under 3 seconds.
- Nudges fire reliably in a fake-clock end-to-end test.

## Phase 8: Research: the benchmark and the two-witnesses study (weeks 20-22)

**Goal.** Turn Earshot's core claims into published, reproducible results.

**What ships**
- CRM-Capture-Bench v1.0: about 1,000 synthetic debriefs plus 30-100 real, consented recordings, with a datasheet, released on Hugging Face with a static leaderboard.
- A harness that works with any provider, caches responses, and has a budget guard. Results feed the public `/lab` page.
- Experiments E1-E7, with hypotheses written in advance and confidence intervals.
- A trained entity re-ranker (ONNX) and an opt-in likely-edit model.
- A tech report and two blog posts.

**Gate**
- The benchmark is public.
- At least four experiments are reported with intervals.
- Two people have reviewed the report.

## Phase 9: Everywhere: MCP, mobile, local mode, imports (weeks 23-26)

**Goal.** Earshot works from your phone, from your AI assistant, and fully offline.

**What ships**
- An MCP server with search, commitments, briefs, and `create_proposal`, plus MCP Apps review cards, so approvals can happen inside Claude or ChatGPT.
- A PWA with an offline audio queue, then an Expo app for locked-screen recording, an Action Button or Shortcuts entry point, a widget, and the share sheet. CarPlay is a stretch goal.
- Local mode: WebGPU transcription, Silero VAD, a distilled extractor, and Kokoro, benchmarked honestly.
- Imports of audio, transcripts, and exports from other open-source notetakers into the same review pipeline.

**Gate**
- The MCP server passes MCP Inspector and works in Claude and ChatGPT.
- The mobile app records a 5-minute debrief with the screen locked.
- Local mode runs a benchmark subset with published accuracy.

## Phase 10: Production hardening and launch (weeks 27-30)

**Goal.** It runs like a product, and a stranger can self-host it in 15 minutes.

**What ships**
- SLOs: session starts at least 99%, 95th-percentile time-to-proposal under 2.5 seconds, sync success at least 99.5%. OpenTelemetry tracing, dashboards, chaos tests, and load tests.
- A full threat model (STRIDE plus the OWASP Top 10 for LLM applications), CSP headers, rate limits, scanning, a key-rotation drill, and retention and erasure flows.
- OpenTofu infrastructure as code, and one-command self-hosting with Docker Compose.
- Performance and accessibility budgets in CI, including a WCAG 2.2 AA audit.
- Complete docs, a landing page, and a launch.

**Gate**
- A clean machine self-hosts from the README in under 15 minutes.
- Two weeks of daily use pass with the SLOs green.
- The launch checklist is complete.

**Release:** v2.0, the public launch.

## Release train

| Release | After | What users get |
|---|---|---|
| v2.0-alpha | Phase 3 | Replay demo, plus live debriefs with your own keys (no CRM yet) |
| v2.0-beta | Phase 6 | Real CRM sync with review; invite-only |
| v2.0 | Phase 10 | Public launch |

## Cut lines

If time runs short, the core is Phases 1-6 plus the benchmark half of Phase 8. After that, add Phase 7 (memory), then Phase 10 (hardening), then Phase 9 (MCP, mobile, local mode). CarPlay goes last.

Phase 1 also has its own cut order, none of which is part of its gate: the Fumadocs site, the theme playground story, components 7-10, and the OpenSSF Scorecard.
