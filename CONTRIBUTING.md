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

## Commands

| Task | Command |
|---|---|
| Run everything locally | `pnpm dev` |
| Lint and format | `pnpm check` or `pnpm check:fix` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` |
| Build | `pnpm build` |
| Regenerate contracts | `pnpm contracts:gen` |
| Storybook | `pnpm --filter @earshot/ui storybook` |
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

## Branches, commits, and pull requests

- **Branch names** follow `<type>/<short-description>`, for example `chore/v2-skeleton` or `docs/phase-1-docs`.
- **Pull request titles** must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat: add the review inbox` or `docs: add ADRs 0000-0018`. A `semantic-pr` check enforces this.
- **Merges are squash merges** that use the PR title as the commit message. That is why the title matters: it becomes the commit, and release-please builds releases from it.
- Keep pull requests focused. The PR template asks what changed, why, whether it needs an ADR, and whether it touches contracts.

## Per-PR previews

Every pull request from a branch in this repository gets its own preview stack: two Workers, `earshot-web-pr-N` and `earshot-edge-pr-N`, and a Neon database branch `preview/pr-N` forked from the seed-only `dev` branch. A Playwright smoke test runs against it, and a comment on the PR lists the URLs. When the PR closes, the Workers and the database branch are deleted. A daily janitor and branch expiry catch anything left over. See [ADR-0017](docs/adr/0017-per-pr-environments.md).

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
