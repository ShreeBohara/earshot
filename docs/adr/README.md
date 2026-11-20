# Architecture decision records

Earshot records architectural decisions as short MADR files, one per decision. See [ADR-0000](0000-record-architecture-decisions.md) for the format and [CONTRIBUTING.md](../../CONTRIBUTING.md) for how to add one.

| ADR | Decision | Status |
|---|---|---|
| [0000](0000-record-architecture-decisions.md) | Record decisions as MADR files in `docs/adr` | Accepted (2026-11-15) |
| [0001](0001-two-voice-engines-cascaded-by-default.md) | Two voice engines, cascaded by default | Accepted (2026-11-15) |
| [0002](0002-browser-connects-to-providers-directly.md) | The browser connects to providers directly, using short-lived tokens | Accepted (2026-11-15) |
| [0003](0003-durable-object-per-session.md) | One Durable Object per session, in a Worker separate from the web app | Accepted (2026-11-15) |
| [0004](0004-event-sourcing-for-sessions.md) | Event sourcing for sessions | Accepted (2026-11-15) |
| [0005](0005-neon-postgres-and-drizzle.md) | Neon Postgres and Drizzle, with RLS, pgvector, and pg_trgm | Accepted (2026-11-15) |
| [0006](0006-better-auth.md) | Better Auth | Accepted (2026-11-15) |
| [0007](0007-crm-writes-only-through-approved-proposals.md) | CRM writes happen only through approved proposals | Accepted (2026-11-15) |
| [0008](0008-crm-reads-from-a-local-mirror.md) | CRM reads come from a local mirror, with optional read-only MCP | Accepted (2026-11-15) |
| [0009](0009-ai-keys-stay-on-the-device.md) | AI keys stay on the device by default; an envelope-encrypted vault is optional | Accepted (2026-11-15) |
| [0010](0010-everything-on-cloudflare.md) | Everything on Cloudflare: OpenNext for the web app, with vinext watched and Vercel for the web app as the fallback | Accepted (2026-11-15); revisit if the OpenNext deploy spike fails or when vinext leaves beta |
| [0011](0011-typescript-product-python-lab.md) | TypeScript for the product, Python for the lab, JSON Schema contracts between them | Accepted (2026-11-15) |
| [0012](0012-shadcn-on-base-ui-with-oklch-tokens.md) | shadcn/ui on Base UI, with OKLCH tokens | Accepted (2026-11-15) |
| [0013](0013-pwa-first-expo-shell-later.md) | PWA first, Expo shell later | Accepted (2026-11-15) |
| [0014](0014-evals-first-with-ci-gates.md) | Evals first, with CI gates | Accepted (2026-11-15) |
| [0015](0015-mit-license.md) | MIT license | Accepted (2026-11-15) |
| [0016](0016-main-is-v2-v1-frozen.md) | `main` is v2; v1 is frozen on a tag and a branch | Accepted (2026-11-15) |
| [0017](0017-per-pr-environments.md) | Per-PR environments: separate Workers plus a Neon branch from a seed-only parent, with expiry and a janitor | Accepted (2026-11-15) |
| [0018](0018-database-access-from-workers.md) | Database access from Workers: a `neon-serverless` pool for tenant transactions, `neon-http` for one-shot reads | Accepted (2026-11-15) |
| [0019](0019-tenant-isolation-with-row-level-security.md) | Tenant isolation with row-level security, proven by pgTAP in PGlite | Accepted (2026-11-15) |
| [0020](0020-event-store.md) | Event store: an append-only log per session, upcasting on read, pure projections, and JSONL files | Accepted (2026-11-15) |
| [0021](0021-key-handling.md) | Key handling: on-device storage, per-request use, an optional envelope-encrypted vault | Accepted (2026-11-15) |
| [0022](0022-voice-engine-and-thin-stt-clients.md) | The voice engine interface, and thin hand-written speech-to-text clients | Accepted (2026-11-15); WP1 confirms the provider details |
| [0023](0023-minted-credentials-and-session-tickets.md) | Provider credentials minted from per-request keys, and signed single-use session tickets for the edge socket | Accepted (2026-11-15) |
| [0024](0024-session-runtime.md) | The session runtime: a SQLite-first SessionDO, acknowledged resume, and a Queue flush to Postgres | Accepted (2026-11-19) |
| [0025](0025-llm-adapters-on-ai-sdk-7.md) | LLM adapters on AI SDK 7: providers built per call, per-turn keys, one batch tool, evidence by quotation, AI Gateway optional | Accepted (2026-11-15) |
| [0026](0026-eval-harness-v0.md) | Eval harness v0: synthetic debrief scripts, Kokoro rendered in CI, Chrome's fake microphone, cassettes, and $0 CI | Proposed (2026-11-19); WP11's second half completes it |
| [0027](0027-contracts-and-the-understanding-pipeline.md) | Contracts and the understanding pipeline: proposals name the record, a deterministic linker resolves it, and the second witness can downgrade it | Proposed (2026-11-19); Phase 4 WP8 completes it |
| [0028](0028-entity-linking.md) | Entity linking: a fixed confusable-name set and its metrics first, then a calibrated linker that links, asks, or proposes a new record | Proposed (2026-11-19); WP4 wrote linker v1, WP5 completes it |
