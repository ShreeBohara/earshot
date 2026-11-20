# Earshot

Earshot is the open-source, verifiable voice layer for your CRM. Say it once, check it in seconds, sync it with proof.

## Status

**Earshot v2 is a rebuild in progress, at the end of Phase 4** (understanding v2). What's built:

- **Foundations (Phases 1–2):** the monorepo, CI, per-PR environments, a design system, sign-in, workspaces under row-level security, the event store, and BYOK key handling with an optional vault.
- **Capture (Phase 3):** push-to-talk and hands-free capture in the browser, speech-to-text streamed straight to AssemblyAI or Deepgram on your key, a Durable Object per session, and proposals extracted by Claude or Groq on your key.
- **Understanding (Phase 4):** the model quotes the names it heard, and a deterministic, calibrated entity linker resolves them to CRM records, asking when it isn't sure. Dates and amounts are re-read from the words. An optional second witness, Groq's Whisper on your key, flags names the keyterm-biased transcript may have misheard.

The whole loop runs end to end in CI on synthetic speech with recorded model responses. Two $0 gates guard it: wrong-account rate and coverage on a confusable-name set, and understanding accuracy on 200 debriefs. It hasn't been deployed or run against live providers yet. Nothing is written to a CRM until Phases 5 and 6 add review and sync. The plan is in [ROADMAP.md](ROADMAP.md).

## What it will do

A rep walks out of a meeting and talks for under a minute. Earshot turns that into CRM changes a person can check quickly. The loop has five steps:

1. **Capture.** Take the rep's own debrief by voice, in the browser or on a phone. By default it records the rep, never the prospect.
2. **Understand.** Turn the words into typed proposals linked to real CRM records: notes, tasks, contacts, deal updates, and commitments.
3. **Verify.** Show each field next to the words that justify it. Flag names that may be misheard, using two transcripts, one biased toward CRM names and one not.
4. **Sync.** Write approved changes to the CRM (HubSpot, Twenty, and Attio are planned), exactly once.
5. **Remember.** Keep account timelines, commitments, and pre-call briefs.

## Principles

- **Rep-only by default.** No prospect recording unless an explicit, announced mode is on.
- **Nothing touches the CRM without approval.**
- **Every field has evidence:** the words, the time, the confidence.
- **Trust the literal words, and verify with two witnesses.**
- **BYOK, always.** Users bring their own keys. There is never a hosted key.
- **Open source and self-hostable**, on inexpensive infrastructure.
- **Evals before features.** Every prompt or model change is measured.
- **Fast and accessible:** WCAG 2.2 AA, interactions under 200 ms.

## Documentation

- [ROADMAP.md](ROADMAP.md): the ten phases, their gates, and the release plan
- [docs/architecture.md](docs/architecture.md): the system, the Phase 1 deployment, and the understanding pipeline
- [docs/adr/](docs/adr/README.md): architecture decision records
- [docs/threat-model.md](docs/threat-model.md): the threat model (v1.2)
- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up and contribute
- [SECURITY.md](SECURITY.md): how to report a vulnerability

## v1

v1 was a hackathon build: a rep talked to a realtime voice agent during a call. It is frozen at the tag `v1.0-hackathon` and on the branch `v1`. Its hosted demo is offline. [docs/v1-retrospective.md](docs/v1-retrospective.md) explains what v1 was, what was wrong with it, and what v2 does differently.

## Quick start

You need Node 26 (pinned in `.nvmrc`) and pnpm 12. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, including uv for the Python lab.

```bash
nvm use
pnpm install
pnpm dev
```

## Repository layout

```text
apps/
  web/            Next.js 16 app, deployed to Cloudflare Workers via OpenNext
  edge/           Hono Worker that owns the Durable Objects (one SessionDO per session)
packages/
  core/           Zod contracts, exported as JSON Schema
  db/             Drizzle schema, migrations, client
  events/         The event store: payload registry, upcasters, projections, replay
  keys/           BYOK keys: on-device storage, the optional vault, validation, redaction
  voice/          The browser voice runtime: capture, speech-to-text, the second witness
  agent/          The turn pipeline: the extractor and its LLM adapters, then understanding
  understanding/  Names, the entity linker, the witness comparison, the normalizers
  demo-crm/       A deterministic demo CRM with deliberately confusable names
  evals/          The eval harness: debriefs, cassettes, the confusable-name set, gates
  tokens/         Design tokens and the theme generator
  ui/             shadcn/ui on Base UI, plus Storybook
  tsconfig/       Shared TypeScript configs
lab/              Python (uv): generated Pydantic contracts, the speech renderer, tests
scripts/      Repository scripts
docs/         ADRs, architecture, threat model, v1 retrospective
.github/      Workflows, CODEOWNERS, templates
```

## License

[MIT](LICENSE)
