# Working in this repo

Earshot v2 is a pnpm + Turborepo monorepo with a Python lab. Read `ROADMAP.md` and `docs/adr/` before changing architecture.

## Map

- `apps/web`: Next.js 16 on Cloudflare Workers via OpenNext
- `apps/edge`: Hono Worker that owns the Durable Objects
- `packages/agent`: turn extraction for `SessionDO`: the proposal extractor, Anthropic and Groq adapters on AI SDK 7, evidence by quotation, and fetch-level cassettes (`@earshot/agent/testing`)
- `packages/core`: Zod contracts, their JSON Schema exports (`schemas/`), and shared fixtures; also the session socket protocol, session tickets, and `uuidv7()`
- `packages/db`: Drizzle schema, migrations, the client, and `withTenant` (row-level security; pgTAP tests in `test/pgtap`)
- `packages/events`: the session event store: payload registry and upcasters, projections, deterministic replay, JSONL
- `packages/keys`: AI key handling: on-device storage, the envelope-encrypted vault, validation, and log redaction
- `packages/demo-crm`: the deterministic demo CRM, with confusable-name groups
- `packages/tokens`, `packages/ui`: design tokens and components
- `packages/tsconfig`: shared TypeScript presets
- `lab/`: Python 3.13 (uv): generated Pydantic contracts, tests, and experiments

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
