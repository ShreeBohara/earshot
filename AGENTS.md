# Working in this repo

Earshot v2 is a pnpm + Turborepo monorepo with a Python lab. Read `ROADMAP.md` and `docs/adr/` before changing architecture.

## Map

- `apps/web`: Next.js 16 on Cloudflare Workers via OpenNext; also the review inbox at `/inbox` (`components/inbox/`, `lib/inbox/`: the loader, cards in lists with roving focus, focus-scoped single-key shortcuts that Settings → Review turns off, the review clock, and reviews through the web route; ADR-0035), tested by the Playwright `inbox` project
- `apps/edge`: Hono Worker that owns the Durable Objects: the session socket, `SessionDO` (the SQLite-first event log, resume, turns, the second witness's comparison, the cost meter, the tray's reviews and snoozes, and the seal after `end`, its last event), the Queue consumer that flushes sessions to Postgres with audit rows for their reviews, and the `purgeSessions` and `sealSessions` RPCs (docs/adr/0024, 0029, 0032)
- `packages/agent`: the turn pipeline for `SessionDO`: the proposal extractor (tool schema v2 and a prompt with no CRM list: the model quotes the words that named each record), Anthropic and Groq adapters on AI SDK 7 (with an opt-in prompt cache, which the live smoke eval uses), `understand()` (evidence by quotation, entity linker v1, the normalizers, and the faithfulness check; ADR-0027), the second witness's comparison for a turn (`witnessTurn`, with the link context `runTurn` hands back; ADR-0029), and fetch-level cassettes (`@earshot/agent/testing`)
- `packages/core`: Zod contracts, their JSON Schema exports (`schemas/`), and shared fixtures; also the session socket protocol, session tickets, and `uuidv7()`
- `packages/db`: Drizzle schema, migrations, the client, and `withTenant` (row-level security; pgTAP tests in `test/pgtap`); also the audit chain, which a trigger hashes per workspace, with `recordAudit`, signed checkpoints (`writeCheckpoint`), `exportAuditChain`, and the offline check (`verifyAuditExport`, `pnpm --filter @earshot/db db:audit-verify <export.json>`; ADR-0033); and review writes after the seal (`writeSessionReviews`, `recordReviewAudit`, the repair path's `sealSessionLog`, and `importSessionLog` for sample sessions; ADR-0032)
- `packages/events`: the session event store: payload registry and upcasters, projections, deterministic replay, JSONL, and the rules every writer of reviews and snoozes keeps (`checkReview`, `checkReviews`, `checkSnooze`; ADR-0032)
- `packages/keys`: AI key handling: on-device storage, the envelope-encrypted vault, validation, and log redaction; also the audit checkpoint signer (Ed25519, `EARSHOT_AUDIT_SIGNING_KEY`; `pnpm --filter @earshot/keys audit-key:new` makes a key; ADR-0033)
- `packages/voice`: the browser voice runtime: capture and resampling, the speech-to-text adapters, the Debrief engine (and each turn's audio for the second witness), the second witness itself (Groq Whisper on the user's key, from the browser; ADR-0029), the client session runtime (`./session`: `SessionClient`, the store the screen subscribes to, and `SessionWitness`, which sends each turn's witness), the price table and pure machines (`./prices`, `./machines`, no DOM), and fakes, including an in-memory SessionDO and a scripted witness (`./testing`); `pnpm test` runs in Node, `pnpm test:browser` in Chromium
- `packages/demo-crm`: the deterministic demo CRM, with confusable-name groups
- `packages/understanding`: the understanding step, pure TypeScript with no DOM or Node APIs (the edge Worker imports it): the name toolkit and homophone list (`./names`), entity linker v1 (`./link`: the per-session index, candidates, features, a calibrated logistic model, the link / ask / new decision, and its frozen `params.v1.json`; ADR-0028), the second witness's comparison (`./witness`: the unbiased reading by word timings or alignment, conflicts at code distance θ_d, downgrades and flags), the value normalizers (`./normalize`: dates with chrono-node's English parser, the call's offset from `Intl`, and Earshot's weekday and end-of-period rules; amounts with currencies; NegEx-style negation; self-corrections), the faithfulness check (`./faithfulness`: each field against its quote by field type, replacing a date, time, or amount only when its reading is unique; ADR-0030), and the likely-edit tiers (`./tiers`: `tierOf`, loud, quiet, or none from a proposal's flags and decisions, which every writer, the cards, and the evals share; ADR-0035)
- `packages/evals`: eval harness v1 (ADR-0031): 200 debrief scripts with ground truth, the 30 hand-written ones the fake-microphone eval renders (`debriefs/`, format v1, upgraded in code) and 170 from a seeded grammar (`debriefs/generated/`, format v2, with what each witness heard; `pnpm --filter @earshot/evals debriefs:gen`, `src/grammar/`), their schema and coverage rules, the understanding eval over all 200 (`@earshot/evals/understanding`: offline cassettes with seeded, labelled model-like errors, the report, the likely-edit tiers' shares, surfacing, and precision, and CI's `checks` gate, `eval:understanding --check` against `baselines/understanding.json` and the tiers' budgets: loud at most an interim 18%, any card marker at most 35%, surfacing at least 95%), the session context their cassettes are keyed on, the cassettes for both LLM adapters (`@earshot/evals/cassettes`; regenerate with `pnpm --filter @earshot/evals cassettes:gen`), and the fake-microphone eval's turn checks, report, baselines (`baseline:update`), and live budget guard. The eval itself is `apps/web/e2e/eval/` (the `capture-smoke` and `capture-eval` Playwright projects). Also the confusable-name set for entity linking (`linking/confusable.v1.jsonl`, frozen; ADR-0028), its seeded mishearing simulator (`@earshot/evals/channel`), its harness (`@earshot/evals/linking`; `pnpm --filter @earshot/evals eval:linking --split test`, `--linker v1` for linker v1 with the second witness and its ablations; CI's `checks` job runs `--linker v1 --split test --check`, gate G1a, against `baselines/linking.json`), and linker v1's fit on the calibration split (`pnpm --filter @earshot/evals linker:fit`, which writes `params.v1.json`, θ_d included). Also the live smoke eval, off until the user turns it on (`@earshot/evals/smoke`; ADR-0031): `smoke.json`'s 30 scripts (re-picked by `smoke:select`) as text through a live model, paced, budget-guarded, and gated against `baselines/smoke-<provider>.json`. `eval:smoke --estimate` and `--offline` cost $0; `eval:smoke` and `baseline:smoke` call the model and need the user's approval. CI's `.github/workflows/eval-smoke.yml` runs it.
- `packages/tokens`, `packages/ui`: design tokens and components
- `packages/tsconfig`: shared TypeScript presets
- `lab/`: Python 3.13 (uv): generated Pydantic contracts, tests, experiments, and the Kokoro renderer for the eval WAVs (`scripts/render_debriefs.py`, in the `tts` group; `--stub` renders tones for local plumbing checks, never for evaluation)

## Commands

- `pnpm install`, then `pnpm dev`
- `pnpm check` (Biome), `pnpm typecheck`, `pnpm test`, `pnpm build`
- `pnpm contracts:gen`: regenerate `packages/core/schemas` and the lab's Pydantic models

## Gates (run before every commit)

- `pnpm check && pnpm typecheck && pnpm test`
- Changed a contract in `packages/core`? Run `pnpm contracts:gen` and commit the generated files.
- Architectural change? Add an ADR in `docs/adr/`.
- Never commit secrets. `.env*` and `.dev.vars*` stay local.

## Conventions

- PR titles are Conventional Commits; PRs are squash-merged.
- TypeScript is strict ESM. No enums, namespaces, or parameter properties (`erasableSyntaxOnly`).
- Internal packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`) and have no build step.
- Node 26 (`.nvmrc`), pnpm 12 (`packageManager`), uv for Python.
