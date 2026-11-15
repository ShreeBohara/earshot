// Renders per-environment wrangler configs from the templates in apps/edge and apps/web.
//
//   pnpm tsx scripts/render-wrangler.ts --target pr-12 --sha <commit>
//   pnpm tsx scripts/render-wrangler.ts --target production --sha <commit>
//
// Writes apps/edge/wrangler.<target>.jsonc and apps/web/wrangler.<target>.jsonc (gitignored).
// Each environment gets its own Workers, so the web Worker's WORKER_SELF_REFERENCE must point
// at its own name (OpenNext doesn't rewrite it) and EDGE must point at the same environment's
// edge Worker. Version preview URLs aren't an option: Cloudflare doesn't generate them for
// Workers that define Durable Objects (docs/adr/0017).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type ParseError, parse } from "jsonc-parser";

export type Target = { kind: "production" } | { kind: "pr"; number: number };

type ServiceBinding = { binding: string; service: string };

export type WranglerConfig = {
  name: string;
  vars?: Record<string, string>;
  services?: ServiceBinding[];
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

export function renderEdge(template: WranglerConfig, target: Target, sha: string): WranglerConfig {
  return withVars({ ...template, name: workerNames(target).edge }, target, sha);
}

export function renderWeb(template: WranglerConfig, target: Target, sha: string): WranglerConfig {
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
  return withVars({ ...template, name: names.web, services }, target, sha);
}

export function readTemplate(path: string): WranglerConfig {
  const errors: ParseError[] = [];
  const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`could not parse ${path}`);
  return config as WranglerConfig;
}

function main(): void {
  const { values } = parseArgs({
    options: { target: { type: "string" }, sha: { type: "string" } },
  });
  if (!values.target || !values.sha) {
    throw new Error("usage: render-wrangler.ts --target <production|pr-N> --sha <commit>");
  }
  const target = parseTarget(values.target);
  const label = targetLabel(target);
  const root = fileURLToPath(new URL("..", import.meta.url));

  const outputs = [
    { app: "edge", render: renderEdge },
    { app: "web", render: renderWeb },
  ] as const;
  for (const { app, render } of outputs) {
    const config = render(readTemplate(`${root}apps/${app}/wrangler.jsonc`), target, values.sha);
    const out = `${root}apps/${app}/wrangler.${label}.jsonc`;
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`wrote apps/${app}/wrangler.${label}.jsonc (${config.name})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
