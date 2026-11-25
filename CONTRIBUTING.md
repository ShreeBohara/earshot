# Contributing to Earshot

Thanks for your interest. Earshot is a rebuild in progress (see [ROADMAP.md](ROADMAP.md)), so some of what's described here, such as per-PR previews and deploys, still waits for the maintainer's accounts and secrets. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Setup

You need:

- **Node.js 26.** The version is pinned in `.nvmrc`, so run `nvm use` (fnm and mise also read it).
- **pnpm 12.** Install it with `npm i -g pnpm@12`, since Corepack no longer ships with Node 25 and later.
- **uv**, for the Python lab in `lab/`. Install Python 3.13 with `uv python install 3.13`.
- **Playwright Chromium**, for end-to-end and Storybook tests: `pnpm exec playwright install chromium`.

Then:

```bash
nvm use
pnpm install
pnpm dev
```

Since pnpm 11, an install fails if a dependency's install script hasn't been reviewed. If `pnpm install` stops with `ERR_PNPM_IGNORED_BUILDS`, pnpm has added placeholder entries under `allowBuilds` in `pnpm-workspace.yaml`. Set each one to true or false only if you recognize the package, and mention it in your pull request.

Don't install wrangler globally. It is a dev dependency, so the lockfile pins its version.

## Local development

`pnpm dev` works on a fresh clone with no accounts and no secrets. In this zero-setup mode the web app:

- **Uses an in-process database.** Without `DATABASE_URL`, `next dev` runs PGlite (Postgres in WebAssembly, with pgvector and pg_trgm). It's stored in `apps/web/.data/pglite/`, which is gitignored, and every migration is applied at startup. To start over, stop the server and delete `apps/web/.data/`. Only one `next dev` process may use that directory at a time.
- **Prints magic links instead of emailing them.** Sign in at `http://localhost:3000/sign-in`, and the link appears in the terminal running `pnpm dev`, marked development-only. Anyone holding a link can sign in with it, so don't paste it anywhere.
- **Uses a fixed development-only auth secret.** Built bundles refuse it.

To use real services, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and uncomment what you need. Each variable is documented in `apps/web/env.d.ts`; restart `pnpm dev` after editing.

| Variable | Without it |
|---|---|
| `DATABASE_URL` | PGlite in `apps/web/.data/`. Set it to your Neon branch's pooled URL to use Neon instead. |
| `BETTER_AUTH_SECRET` | A development-only secret. Required outside `next dev`, at least 32 characters (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | `http://localhost:3000`. Required outside `next dev`, where it must use https or be localhost. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Only `BETTER_AUTH_URL`'s origin may call the auth API. |
| `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` | No GitHub button. The callback URL is `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | No Google button. The callback URL is `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `RESEND_API_KEY` and `EMAIL_FROM` | Links print to the terminal in development. Built bundles refuse to send. |
| `EARSHOT_VAULT_MASTER_KEY` | The server vault is off: Settings → Keys offers only on-device storage. Set it (32 random bytes, base64; `.dev.vars.example` shows how to generate one) to try storing keys on the server. |
| `EARSHOT_SESSION_TICKET_SECRET` | Session tickets are signed with a development-only secret, which the edge Worker's `wrangler dev` also falls back to. Required outside `next dev`, at least 32 bytes, and the same on both Workers ([ADR-0023](docs/adr/0023-minted-credentials-and-session-tickets.md)). |
| `EDGE_PUBLIC_URL` | The browser opens session sockets on `EDGE_DEV_URL` (`http://localhost:8787`). Required outside `next dev`: the edge Worker's origin, https unless it's localhost. |
| `EARSHOT_AUDIT_SIGNING_KEY` | Reviews, policy changes, and exports are signed with a committed development-only key ([ADR-0033](docs/adr/0033-tamper-evident-approvals.md)). Outside `next dev` the development key is refused, and without a key of its own a deployment fails closed: no reviews, no policies. Make one with `pnpm --filter @earshot/keys audit-key:new`, which prints it and writes no file, and set the same value on both Workers. |
| `EARSHOT_AUDIT_RETIRED_KEYS` | No retired keys. When you rotate the signing key, add the old key's public JWK here, with `retiredAt`, so its checkpoints still verify. |

`pnpm --filter @earshot/web preview` runs the production Worker build in workerd. It has no zero-setup mode, so it needs `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL=http://localhost:8787` in `.dev.vars`. Starting a session there also needs `EARSHOT_SESSION_TICKET_SECRET` and `EDGE_PUBLIC_URL`, with the edge Worker on another port (`wrangler dev --port 8788`).

### A debrief with no keys (fake voice)

Under `next dev`, a whole debrief can run with no keys and no provider calls. Your microphone still records, but the fake speech-to-text adapter ignores the audio: each press "hears" the next line of the scripted demo session. The edge Worker's e2e entry (`apps/edge/src/e2e.ts`) answers every turn from `@earshot/agent`'s committed cassettes.

1. Start the e2e edge Worker instead of the usual one: `pnpm --filter @earshot/edge dev:e2e`. It listens on port 8787 and accepts sockets from `http://localhost:3000`.
2. Start the web app: `pnpm --filter @earshot/web dev`. Its `dev` script first writes the voice assets (the capture worklet and the VAD files) into `apps/web/public/`. If you start `next dev` some other way, run `pnpm --filter @earshot/web exec earshot-voice-assets public` first.
3. Sign in, open `http://localhost:3000/capture?voice=fake`, and click **Start debrief**. To get fake mode on every visit, start the web app with `EARSHOT_FAKE_VOICE=1`.
4. Hold Space (or the button) for about 1.6 seconds per line. The banner shows the next line. Seven presses give five proposals. `Esc` ends the debrief and shows what it cost: the cassettes' token counts priced at the real rates, and nothing was billed.

Fake mode runs the second witness (ADR-0029) only when the page asks: set `globalThis.__earshotFakeWitness = { turns: ["what the witness hears", null] }` before the page loads (one entry per press; `null` for the line as said), as `e2e/capture/second-witness.spec.ts` does to script a mishearing. Without it, the witness is off and each turn's `witness` message says so. Nothing goes to Groq in fake mode.

Fake mode sends `start` with the scenario's entities, call time, and time zone instead of your CRM's, because each cassette is keyed by the whole LLM request. The scenario comes from the e2e Worker's `GET /v1/e2e/scenario`. That route also proves the e2e Worker is the one listening: if it doesn't answer, the screen refuses to start, since the production edge Worker would send the turn to a real provider. Production builds compile fake mode out, and `build:worker`'s bundle check fails if the fake adapter or the scenario route reach a bundle.

### The review inbox and the pilot, locally

Sign in, and onboarding offers the demo CRM. Then Settings → Data's **Load sample debriefs** loads the review pilot's set, `pilot.v1`: ten sealed debriefs with 40 proposals, 8 of them seeded wrong accounts ([ADR-0039](docs/adr/0039-review-time-evaluation.md)). Open `/inbox` to review them. Under `next dev` the page also offers **Load the test debriefs (development)**, two debriefs with seven cards, one in every tier, which the inbox's end-to-end tests use, and **Load a finishing debrief (development)**, which shows the "Finishing" state until the repair path seals it 10 minutes on.

Debriefs you record yourself under `pnpm dev` don't reach the inbox: zero-setup mode has no flush to Postgres, so they're never sealed there. Review them in the capture screen's tray while the debrief is live, over the socket.

The pilot page needs no sign-in: `/pilot?p=1` to `?p=5` for a participant's order, or `?p=ci` for CI's. It keeps progress in the tab only, and offers a results file at the end. To run the pilot itself, follow `docs/pilot/protocol.md`; the analysis is pre-registered in `docs/pilot/pre-registration.md`:

```sh
pnpm --filter @earshot/evals pilot:analyze results/*.json > docs/pilot/results.md
```

Keep the results files outside the repository, and never commit them. `pnpm --filter @earshot/evals pilot:gen --check` confirms the committed set matches its builder and its SHA-256; never regenerate the set once the pilot has begun.

### The audit chain, offline

Settings → Account's export (`GET /api/account/export`) carries the workspace's audit chain, its signed checkpoints, and the public keys. Check one offline:

```sh
pnpm --filter @earshot/db db:audit-verify export.json --keys keys.json
```

`--keys` takes the keys saved from `/api/audit/keys`, which is stronger than trusting the file's own. An export from `pnpm dev` is signed with the development key, which anyone can sign with, so it passes only with `--allow-development-key`. `--allow-unsigned-tail` accepts entries written after the last checkpoint and reports them; that's "Chain intact", never "OK". The script exits 0 only for "OK", 2 for an accepted unsigned tail, and 1 otherwise, but `pnpm --filter` reports any failure as 1: to see the 2, run `pnpm exec tsx scripts/audit-verify.ts` from `packages/db`.

### End-to-end tests

End-to-end tests start their own zero-setup dev server on port 3100: run `pnpm --filter @earshot/web exec playwright test e2e/sign-in.spec.ts e2e/keys.spec.ts`. The capture tests (`e2e/capture/`) also start the e2e edge Worker on port 8787, and give Chrome a fake microphone. They cover a keyboard-only debrief, the live region, reduced motion, the docked session across pages, press-to-feedback under 200 ms, the second witness's one-time consent, and a scripted mishearing that the second witness turns into a question: `pnpm --filter @earshot/web exec playwright test e2e/capture`. The reduced-motion test compares pixels only against a baseline for your platform. Where there's none (CI's Linux has none yet), it runs its motion checks and skips the pixels. Record a baseline with `--update-snapshots`. `e2e/keys.spec.ts` signs up a new user with the magic link the server prints, which it reads from `apps/web/.data/e2e/dev-server.log`, so it needs zero-setup mode: with a `.dev.vars` file present, wrangler ignores the port the tests set for `BETTER_AUTH_URL`. Move the file aside while it runs. The health check in `e2e/smoke.spec.ts` needs a deployed stack, so it runs only against previews (set `BASE_URL`).

The review inbox's tests (`e2e/inbox/`, the `inbox` project) sign in, load the demo CRM and the test debriefs, and review by keyboard and pointer: accept, reject, snooze, edit, undo, "accept all" and its checkpoint, the shortcuts' scope and their switch, corrections (a silent wrong account fixed with c, then 2; a typed correction, and one it can't read), the recap, and a CRM change shown three ways, with focus never on `<body>` and axe in every state, light and dark. The pilot's (`e2e/pilot/`, the `pilot` project) run a participant to the results file, check the page requests only static files, and load the sample debriefs into the inbox. The scripted reviewer is its own project (`reviewer`). Run them with `CI=1`, so a port another worktree's server holds fails the run instead of being reused:

```sh
CI=1 pnpm --filter @earshot/web exec playwright test e2e/inbox e2e/pilot e2e/pilot/scripted-reviewer.spec.ts
```

### The fake-microphone eval

`e2e/eval/` plays the 30 eval debriefs (`packages/evals/debriefs/`) as WAVs through Chrome's fake microphone into the capture screen, one browser per WAV, on the same fake mode and e2e Worker, and checks every turn's proposals against its script ([ADR-0026](docs/adr/0026-eval-harness-v0.md)). A smoke test runs first, and the eval doesn't run if it fails. CI plays Kokoro's WAVs. Locally, without downloading the model, render stub tones instead. They check the plumbing only, are **not an evaluation**, and CI refuses them:

```sh
uv run --project lab python lab/scripts/render_debriefs.py --stub
cd apps/web
EARSHOT_EVAL_WAVS=lab/.cache/wavs-stub EARSHOT_EVAL_SCRIPTS=d001,d010 pnpm exec playwright test --project=capture-eval --workers=1
```

Leave out `EARSHOT_EVAL_SCRIPTS` for all 30, about 15 minutes in real time. The run prints a report, with latency p50 and p95 from each turn's `turn.measured`, and writes it to `apps/web/.data/eval/report.json`. With Kokoro's WAVs in `lab/.cache/wavs` (`uv sync --project lab --group tts`, then `render_debriefs.py` without `--stub`), leave out `EARSHOT_EVAL_WAVS`. `packages/evals/baselines/ci.json` is written on purpose, from a green CI `eval` run's `eval-report` artifact: `pnpm --filter @earshot/evals baseline:update <report.json>`.

### The eval tiers

Each tier, what runs it, and what it costs ([ADR-0031](docs/adr/0031-eval-harness-v1.md)). The three $0 gates run in seconds, so run them before you push anything that touches `packages/agent`, `packages/understanding`, or `packages/evals`. `eval:understanding --check` also holds the likely-edit tiers to their budgets: loud on at most 18% of proposals (an interim ceiling; the target is 15%), a card marker on at most 35%, and at least 95% of the seeded errors marked.

| Tier | Run it locally | In CI | Cost |
|---|---|---|---|
| Linking gate (G1a): linker v1 and the second witness on the confusable-name set's test split | `pnpm --filter @earshot/evals eval:linking --linker v1 --split test --check` | `checks`, every PR | $0 |
| Understanding gate (G2b, G3a): all 200 debriefs through each LLM adapter's offline cassettes | `pnpm --filter @earshot/evals eval:understanding --check` | `checks`, every PR | $0 |
| Recap gate (Phase 5): all 200 debriefs' recaps through each LLM adapter's offline cassettes, with seeded bad sentences and invented lens quotes ([ADR-0037](docs/adr/0037-the-recap.md)) | `pnpm --filter @earshot/evals eval:recap --check` | `checks`, every PR | $0 |
| The fake-microphone eval: 30 rendered debriefs through the capture screen | As above | `ui` (5 scripts) and `eval` (all 30) | $0 |
| The scripted reviewer (Phase 5's G1a and G2a): `pilot.v1` by keyboard on a fake clock with the manifest's right answers; markers, keys per decision, focus, axe in every state, and the KLM estimate per card against `baselines/pilot-klm.json` ([ADR-0039](docs/adr/0039-review-time-evaluation.md)) | `CI=1 pnpm --filter @earshot/web exec playwright test e2e/pilot/scripted-reviewer.spec.ts` | `ui`, every PR | $0 |
| Live smoke eval: 30 debriefs as text through a real model, against a three-run baseline | `EVAL_SMOKE_BUDGET_USD=0.10 pnpm --filter @earshot/evals eval:smoke --offline` runs it through the cassettes for $0, which checks the plumbing only. A live run also needs `EVAL_SMOKE_ANTHROPIC_KEY` | `eval-smoke`, skipped until `EVAL_SMOKE_ENABLED` is `true` | Budget-guarded: about $0.03 a run with the prompt cache |
| `eval-live`: real providers end to end | `workflow_dispatch` on `eval-live` | By hand | Budget-guarded |
| The recap's live check: one recap on each provider, from a synthetic debrief | `EARSHOT_RECAP_LIVE=1 EVAL_ANTHROPIC_KEY=… EVAL_GROQ_KEY=… pnpm --filter @earshot/evals recap:live --out recap-live.json`, only with the maintainer's approval | Never | Under $0.01 |

What to regenerate, and in what order, when you change:

- **A debrief script or the generator:** `pnpm --filter @earshot/evals debriefs:gen` (generated scripts only), then `cassettes:gen`, then `eval:understanding --write-baseline`. Review the baseline's diff before you commit it; the baseline is tied to the scripts' bytes, so the gate fails until it's re-recorded.
- **The prompt, the tool schema, or request options in `@earshot/agent`:** `pnpm --filter @earshot/evals cassettes:gen`, and `@earshot/agent`'s cassettes the same way.
- **The recap's prompt, tool, or checks, or the debriefs:** `pnpm --filter @earshot/evals recap:gen` rebuilds the recap cassettes (a test fails if the committed ones drift), then `eval:recap --write-baseline` re-records `baselines/recap.json`. Review both diffs.
- **The smoke set:** `pnpm --filter @earshot/evals smoke:select` rewrites `smoke.json`. A new baseline then has to be recorded live: dispatch `eval-smoke` with `baseline` checked, then review and commit the artifact.
- **Linker v1's features or its fit:** `pnpm --filter @earshot/evals linker:fit`, then `eval:linking --linker v1 --split test --write-baseline`. Tune on the calibration split only; the test split is what G1 is judged on.
- **What a review card shows, or the keys a decision takes:** the scripted reviewer fails when a pilot card's KLM estimate rises more than 10% above `baselines/pilot-klm.json`. If the change is meant, re-record the baseline from the committed set with `CI=1 EARSHOT_PILOT_KLM=record pnpm --filter @earshot/web exec playwright test e2e/pilot/scripted-reviewer.spec.ts`, review its diff (each card's words, keys, and estimate, and the median), and commit it.

## Commands

| Task | Command |
|---|---|
| Run everything locally | `pnpm dev` |
| Lint and format | `pnpm check` or `pnpm check:fix` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` |
| End-to-end tests (Playwright and axe), as CI's `ui` job runs them | `CI=1 pnpm --filter @earshot/web exec playwright test e2e/sign-in.spec.ts e2e/demo.spec.ts e2e/keys.spec.ts e2e/capture e2e/inbox e2e/pilot e2e/pilot/scripted-reviewer.spec.ts` |
| The $0 eval gates | `pnpm --filter @earshot/evals eval:linking --linker v1 --split test --check`, `eval:understanding --check`, and `eval:recap --check` |
| The pilot's analysis | `pnpm --filter @earshot/evals pilot:analyze results/*.json > docs/pilot/results.md` |
| Check an account export's audit chain | `pnpm --filter @earshot/db db:audit-verify export.json --keys keys.json` |
| Make an audit signing key | `pnpm --filter @earshot/keys audit-key:new` |
| A debrief with no keys | `pnpm --filter @earshot/edge dev:e2e` and `pnpm --filter @earshot/web dev`, then `/capture?voice=fake` |
| The fake-microphone eval, on stub WAVs | `uv run --project lab python lab/scripts/render_debriefs.py --stub`, then in `apps/web`: `EARSHOT_EVAL_WAVS=lab/.cache/wavs-stub pnpm exec playwright test --project=capture-eval --workers=1` |
| Build | `pnpm build` |
| Regenerate contracts | `pnpm contracts:gen` |
| Storybook (`@earshot/ui`, plus the web app's stories) | `pnpm --filter @earshot/ui storybook` |
| Migrate your branch | `pnpm --filter @earshot/db db:migrate` |
| Run the Worker build locally | `pnpm --filter @earshot/web preview` |
| Deploy by hand | `pnpm --filter @earshot/edge exec wrangler deploy`, then `pnpm --filter @earshot/web deploy` |
| Regenerate the theme | `pnpm --filter @earshot/tokens theme --base 85,0.01 --accent 0.30,0.03,265 --contrast 50` |
| Python checks | `pnpm turbo run lint typecheck test --filter=@earshot/lab` |

Before you commit, run `pnpm check && pnpm typecheck && pnpm test`. Deploying by hand needs a Cloudflare account, which you don't need for ordinary contributions.

## Changing a contract

Contracts are Zod schemas in `packages/core`. They export to JSON Schema, which generates the Pydantic models in `lab/`. After you change a contract, run:

```bash
pnpm contracts:gen
```

Commit the regenerated files. CI runs `pnpm contracts:gen && git diff --exit-code`, so a contract change without regenerated output fails. The shared fixtures in `packages/core/fixtures/{valid,invalid}` run in both Vitest and pytest; if one language accepts what the other rejects, CI fails.

The session socket protocol and session tickets in `packages/core` are TypeScript-only: they aren't exported, and their tests are in `packages/core/test` ([ADR-0011](docs/adr/0011-typescript-product-python-lab.md)). A new provider key shape goes in two places, `SECRET_PATTERNS` in `packages/keys/src/redact.ts` and `KEY_SHAPES` in `packages/core/src/key-shapes.ts`; a test fails if they differ.

## Branches, commits, and pull requests

- **Branch names** follow `<type>/<short-description>`, for example `chore/v2-skeleton` or `docs/phase-1-docs`.
- **Pull request titles** must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat: add the review inbox` or `docs: add ADRs 0000-0018`. A `semantic-pr` check enforces this.
- **Merges are squash merges** that use the PR title as the commit message. That is why the title matters: it becomes the commit, and release-please builds releases from it.
- Keep pull requests focused. The PR template asks what changed, why, whether it needs an ADR, and whether it touches contracts.

## Per-PR previews

Every pull request from a branch in this repository gets its own preview stack: two Workers, `earshot-web-pr-N` and `earshot-edge-pr-N`, and a Neon database branch `preview/pr-N` forked from the seed-only `dev` branch. A Playwright smoke test runs against it, and a comment on the PR lists the URLs. When the PR closes, the Workers and the database branch are deleted. A daily janitor and branch expiry catch anything left over. See [ADR-0017](docs/adr/0017-per-pr-environments.md).

**Deploy secrets.** Previews and production read their secrets from the GitHub environments `preview` and `production`. The web Worker receives these, through a secrets file at deploy time, whenever they're set:

| Secret | What it does |
|---|---|
| `BETTER_AUTH_SECRET` | Required: auth fails closed without it. |
| `RESEND_API_KEY` | With the `EMAIL_FROM` variable, sends magic links. |
| `AUTH_GITHUB_CLIENT_SECRET`, `AUTH_GOOGLE_CLIENT_SECRET` | Production only, with the `AUTH_GITHUB_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_ID` variables: OAuth sign-in. |
| `EARSHOT_VAULT_MASTER_KEY` | Optional: turns on the server vault for AI keys. In `production`, production's key; in `preview`, the `dev` branch's key, because preview databases fork from `dev` with its sealed rows. Never change it outside [the rotation runbook](docs/vault-key-rotation.md). |
| `EARSHOT_SESSION_TICKET_SECRET` | Required for sessions: the session and ticket routes fail closed without it. At least 32 random bytes (`openssl rand -base64 32`), one per environment. The edge Worker verifies tickets with the same value, so it gets this secret too once its socket route lands (Phase 3 WP6). |

`render-wrangler.ts` also gives each web Worker `EDGE_PUBLIC_URL`, its own environment's edge Worker origin, where browsers open session sockets.

`EARSHOT_AUDIT_SIGNING_KEY` isn't passed by either deploy step yet. Until it is, and the same key is set on both Workers, a deployment refuses reviews (503 `audit_unavailable`) and applies no approval policy ([ADR-0033](docs/adr/0033-tamper-evident-approvals.md)); `/api/health` reports the key's state as `audit.signingKey`, never the key.

**Pull requests from forks don't get a preview.** The preview and deploy steps need secrets, such as Cloudflare and Neon credentials, and GitHub withholds secrets from fork PRs so that untrusted code can never read them. Workflows deliberately use `pull_request`, never `pull_request_target`. Fork PRs still run CI, which doesn't need secrets, and the Chromatic step is skipped when its token is absent.

## Adding an ADR

Architectural changes need a decision record. ADRs use MADR's short form and live in `docs/adr/`.

1. Copy the structure of an existing ADR.
2. Name the file `NNNN-<slug>.md`, using the next four-digit number.
3. Write the title (`# ADR-NNNN: <decision>`) and these sections: Status, Context and problem, Considered options, Decision, Consequences (good and bad), and optionally More information.
4. Add a row to the table in `docs/adr/README.md`.
5. Open a pull request.

See [ADR-0000](docs/adr/0000-record-architecture-decisions.md) for the reasoning.

## Database migrations: expand, then contract

Never ship a breaking schema change in a single deploy. Make the change in two steps:

1. **Expand.** Add the new column, table, or index in a way the running code still works with, and deploy it.
2. **Contract.** After the code no longer uses the old shape, remove it in a later deploy.

Migrations always use the direct, non-pooled database URL.

## Security

Don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md). Never commit secrets: `.env*` and `.dev.vars*` files are git-ignored, and push protection is on.
