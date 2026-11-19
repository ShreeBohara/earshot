// Renders per-environment wrangler configs from the templates in apps/edge and apps/web.
//
//   pnpm tsx scripts/render-wrangler.ts --target pr-12 --sha <commit> [--workers-subdomain <name>]
//   pnpm tsx scripts/render-wrangler.ts --target production --sha <commit> [--workers-subdomain <name>]
//
// Writes apps/edge/wrangler.<target>.jsonc and apps/web/wrangler.<target>.jsonc (gitignored).
// Each environment gets its own Workers, so the web Worker's WORKER_SELF_REFERENCE must point
// at its own name (OpenNext doesn't rewrite it) and EDGE must point at the same environment's
// edge Worker. With --workers-subdomain, the web Worker also gets BETTER_AUTH_URL, its own
// workers.dev origin, and EDGE_PUBLIC_URL, the same environment's edge Worker's, where browsers
// open session sockets; the edge Worker gets WEB_ORIGIN, the web Worker's origin, the only one
// allowed to open them. Each environment also gets its own flush queues (earshot-flush-pr-N and
// earshot-flush-pr-N-dlq), which the preview workflow creates before deploying. Version preview URLs aren't an option: Cloudflare doesn't generate them
// for Workers that define Durable Objects (docs/adr/0017).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type ParseError, parse } from "jsonc-parser";

export type Target = { kind: "production" } | { kind: "pr"; number: number };

type ServiceBinding = { binding: string; service: string };

type QueueProducer = { binding: string; queue: string };
type QueueConsumer = { queue: string; dead_letter_queue?: string; [key: string]: unknown };

export type WranglerConfig = {
  name: string;
  vars?: Record<string, string>;
  services?: ServiceBinding[];
  queues?: { producers?: QueueProducer[]; consumers?: QueueConsumer[] };
  [key: string]: unknown;
};

const MAX_WORKER_NAME = 63;

export function parseTarget(value: string): Target {
  if (value === "production") return { kind: "production" };
  const match = /^pr-([1-9]\d*)$/.exec(value);
  if (!match?.[1]) throw new Error(`invalid target "${value}": use "production" or "pr-<number>"`);
  return { kind: "pr", number: Number(match[1]) };
}

export function targetLabel(target: Target): string {
  return target.kind === "production" ? "production" : `pr-${target.number}`;
}

export function workerNames(target: Target): { web: string; edge: string } {
  const suffix = target.kind === "pr" ? `-pr-${target.number}` : "";
  const names = { web: `earshot-web${suffix}`, edge: `earshot-edge${suffix}` };
  for (const name of Object.values(names)) {
    if (name.length > MAX_WORKER_NAME || !/^[a-z0-9-]+$/.test(name)) {
      throw new Error(`invalid Worker name "${name}"`);
    }
  }
  return names;
}

function withVars(config: WranglerConfig, target: Target, sha: string): WranglerConfig {
  return { ...config, vars: { ...config.vars, DEPLOY_ENV: targetLabel(target), GIT_SHA: sha } };
}

/**
 * The flush queue and its dead-letter queue for a target (docs/adr/0024). Previews get their own,
 * so a PR's consumer never takes production's messages; preview-cleanup.yml deletes them with the
 * PR, and the janitor sweeps any it misses.
 */
export function queueNames(target: Target): { flush: string; deadLetter: string } {
  const flush = target.kind === "pr" ? `earshot-flush-pr-${target.number}` : "earshot-flush";
  const names = { flush, deadLetter: `${flush}-dlq` };
  for (const name of Object.values(names)) {
    if (name.length > MAX_WORKER_NAME || !/^[a-z0-9-]+$/.test(name)) {
      throw new Error(`invalid queue name "${name}"`);
    }
  }
  return names;
}

/** The template's queues, renamed for the target. Throws if the template lacks either queue. */
function renderQueues(template: WranglerConfig, target: Target): WranglerConfig["queues"] {
  const names = queueNames(target);
  const producers = (template.queues?.producers ?? []).map((producer) => {
    if (producer.binding === "FLUSH") return { ...producer, queue: names.flush };
    if (producer.binding === "FLUSH_DLQ") return { ...producer, queue: names.deadLetter };
    return producer;
  });
  const consumers = (template.queues?.consumers ?? []).map((consumer) => ({
    ...consumer,
    queue: names.flush,
    dead_letter_queue: names.deadLetter,
  }));
  for (const binding of ["FLUSH", "FLUSH_DLQ"]) {
    if (!producers.some((producer) => producer.binding === binding)) {
      throw new Error(`edge template is missing the ${binding} queue producer`);
    }
  }
  if (consumers.length !== 1) throw new Error("edge template must consume exactly one queue");
  return { ...template.queues, producers, consumers };
}

export function renderEdge(
  template: WranglerConfig,
  target: Target,
  sha: string,
  options: { workersSubdomain?: string | undefined } = {},
): WranglerConfig {
  const rendered = withVars(
    { ...template, name: workerNames(target).edge, queues: renderQueues(template, target) },
    target,
    sha,
  );
  if (options.workersSubdomain) {
    rendered.vars = { ...rendered.vars, WEB_ORIGIN: webOrigin(target, options.workersSubdomain) };
  }
  return rendered;
}

function workersDevOrigin(worker: string, workersSubdomain: string): string {
  if (!/^[a-z0-9-]+$/.test(workersSubdomain)) {
    throw new Error(`invalid workers.dev subdomain "${workersSubdomain}"`);
  }
  return `https://${worker}.${workersSubdomain}.workers.dev`;
}

/**
 * The web Worker's public origin on workers.dev. Better Auth binds magic links, OAuth callbacks,
 * and passkeys to it (BETTER_AUTH_URL).
 */
export function webOrigin(target: Target, workersSubdomain: string): string {
  return workersDevOrigin(workerNames(target).web, workersSubdomain);
}

/**
 * The edge Worker's public origin on workers.dev, where browsers open session sockets
 * (EDGE_PUBLIC_URL on the web Worker, docs/adr/0023).
 */
export function edgeOrigin(target: Target, workersSubdomain: string): string {
  return workersDevOrigin(workerNames(target).edge, workersSubdomain);
}

export function renderWeb(
  template: WranglerConfig,
  target: Target,
  sha: string,
  options: { workersSubdomain?: string | undefined } = {},
): WranglerConfig {
  const names = workerNames(target);
  const services = (template.services ?? []).map((binding) => {
    if (binding.binding === "WORKER_SELF_REFERENCE") return { ...binding, service: names.web };
    if (binding.binding === "EDGE") return { ...binding, service: names.edge };
    return binding;
  });
  for (const required of ["WORKER_SELF_REFERENCE", "EDGE"]) {
    if (!services.some((s) => s.binding === required)) {
      throw new Error(`web template is missing the ${required} service binding`);
    }
  }
  const rendered = withVars({ ...template, name: names.web, services }, target, sha);
  if (options.workersSubdomain) {
    rendered.vars = {
      ...rendered.vars,
      BETTER_AUTH_URL: webOrigin(target, options.workersSubdomain),
      EDGE_PUBLIC_URL: edgeOrigin(target, options.workersSubdomain),
    };
  }
  return rendered;
}

export function readTemplate(path: string): WranglerConfig {
  const errors: ParseError[] = [];
  const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`could not parse ${path}`);
  return config as WranglerConfig;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      sha: { type: "string" },
      "workers-subdomain": { type: "string" },
    },
  });
  if (!values.target || !values.sha) {
    throw new Error(
      "usage: render-wrangler.ts --target <production|pr-N> --sha <commit> [--workers-subdomain <name>]",
    );
  }
  const workersSubdomain = values["workers-subdomain"];
  const target = parseTarget(values.target);
  const label = targetLabel(target);
  const root = fileURLToPath(new URL("..", import.meta.url));

  const outputs = [
    {
      app: "edge",
      render: (template: WranglerConfig, t: Target, sha: string) =>
        renderEdge(template, t, sha, { workersSubdomain }),
    },
    {
      app: "web",
      render: (template: WranglerConfig, t: Target, sha: string) =>
        renderWeb(template, t, sha, { workersSubdomain }),
    },
  ] as const;
  for (const { app, render } of outputs) {
    const config = render(readTemplate(`${root}apps/${app}/wrangler.jsonc`), target, values.sha);
    const out = `${root}apps/${app}/wrangler.${label}.jsonc`;
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`wrote apps/${app}/wrangler.${label}.jsonc (${config.name})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
