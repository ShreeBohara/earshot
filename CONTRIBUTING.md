# Contributing to Earshot

Thanks for your interest. Earshot is a rebuild in progress (see [ROADMAP.md](ROADMAP.md)), so some of what's described here is being put in place during Phase 1. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

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

`pnpm --filter @earshot/web preview` runs the production Worker build in workerd. It has no zero-setup mode, so it needs `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL=http://localhost:8787` in `.dev.vars`. Starting a session there also needs `EARSHOT_SESSION_TICKET_SECRET` and `EDGE_PUBLIC_URL`, with the edge Worker on another port (`wrangler dev --port 8788`).

End-to-end tests start their own zero-setup dev server on port 3100: run `pnpm --filter @earshot/web exec playwright test e2e/sign-in.spec.ts e2e/keys.spec.ts`. `e2e/keys.spec.ts` signs up a new user with the magic link the server prints, which it reads from `apps/web/.data/e2e/dev-server.log`, so it needs zero-setup mode: with a `.dev.vars` file present, wrangler ignores the port the tests set for `BETTER_AUTH_URL`. Move the file aside while it runs. The health check in `e2e/smoke.spec.ts` needs a deployed stack, so it runs only against previews (set `BASE_URL`).

## Commands

| Task | Command |
|---|---|
| Run everything locally | `pnpm dev` |
| Lint and format | `pnpm check` or `pnpm check:fix` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` |
| End-to-end tests (Playwright and axe) | `pnpm --filter @earshot/web exec playwright test e2e/sign-in.spec.ts e2e/keys.spec.ts` |
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
