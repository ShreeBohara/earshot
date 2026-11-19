// Deletes preview resources whose PR is closed: earshot-{web,edge}-pr-N Workers, their
// earshot-flush-pr-N queues (and -dlq), and Neon preview/pr-N branches. A safety net for
// preview-cleanup.yml; Neon branch expiry is the last one.
//
//   pnpm tsx scripts/janitor.ts [--dry-run]
//
// Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY, NEON_PROJECT_ID,
// GITHUB_TOKEN, and GITHUB_REPOSITORY (owner/name).
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const WORKER_PATTERN = /^earshot-(web|edge)-pr-(\d+)$/;
const QUEUE_PATTERN = /^earshot-flush-pr-(\d+)(?:-dlq)?$/;
const BRANCH_PATTERN = /^preview\/pr-(\d+)$/;

type Named = { id: string; name: string };

export type Orphans = { workers: string[]; queues: Named[]; branches: Named[] };

/**
 * Pure planning step: which resources belong to PRs that are no longer open. Workers go first: a
 * queue can't be deleted while a Worker still consumes it.
 */
export function planCleanup(
  workerNames: string[],
  branches: Named[],
  isOpen: (pr: number) => boolean,
  queues: Named[] = [],
): Orphans {
  const workers = workerNames
    .map((name) => ({ name, match: WORKER_PATTERN.exec(name) }))
    .filter(({ match }) => match?.[2] !== undefined && !isOpen(Number(match[2])))
    // Delete web Workers before edge Workers: web binds to edge.
    .sort((a, b) => (a.match?.[1] === "web" ? -1 : 0) - (b.match?.[1] === "web" ? -1 : 0))
    .map(({ name }) => name);
  const orphanBranches = branches.filter((branch) => {
    const match = BRANCH_PATTERN.exec(branch.name);
    return match?.[1] !== undefined && !isOpen(Number(match[1]));
  });
  const orphanQueues = queues.filter((queue) => {
    const match = QUEUE_PATTERN.exec(queue.name);
    return match?.[1] !== undefined && !isOpen(Number(match[1]));
  });
  return { workers, queues: orphanQueues, branches: orphanBranches };
}

export function prNumbers(
  workerNames: string[],
  branchNames: string[],
  queueNames: string[] = [],
): number[] {
  const numbers = new Set<number>();
  for (const name of workerNames) {
    const match = WORKER_PATTERN.exec(name);
    if (match?.[2]) numbers.add(Number(match[2]));
  }
  for (const name of branchNames) {
    const match = BRANCH_PATTERN.exec(name);
    if (match?.[1]) numbers.add(Number(match[1]));
  }
  for (const name of queueNames) {
    const match = QUEUE_PATTERN.exec(name);
    if (match?.[1]) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function request<T>(url: string, init: RequestInit, token: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const dryRun = values["dry-run"] ?? false;

  const cfToken = env("CLOUDFLARE_API_TOKEN");
  const account = env("CLOUDFLARE_ACCOUNT_ID");
  const neonKey = env("NEON_API_KEY");
  const project = env("NEON_PROJECT_ID");
  const ghToken = env("GITHUB_TOKEN");
  const repo = env("GITHUB_REPOSITORY");

  const cf = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`;
  const cfQueues = `https://api.cloudflare.com/client/v4/accounts/${account}/queues`;
  const neon = `https://console.neon.tech/api/v2/projects/${project}/branches`;

  const scripts = await request<{ result: { id: string }[] }>(cf, {}, cfToken);
  const listedQueues = await request<{ result: { queue_id: string; queue_name: string }[] }>(
    cfQueues,
    {},
    cfToken,
  );
  const branches = await request<{ branches: { id: string; name: string }[] }>(neon, {}, neonKey);
  const workerNames = scripts.result.map((s) => s.id);
  const queues = listedQueues.result.map((q) => ({ id: q.queue_id, name: q.queue_name }));

  const open = new Set<number>();
  for (const pr of prNumbers(
    workerNames,
    branches.branches.map((b) => b.name),
    queues.map((q) => q.name),
  )) {
    const pull = await request<{ state: string }>(
      `https://api.github.com/repos/${repo}/pulls/${pr}`,
      { headers: { "x-github-api-version": "2022-11-28" } },
      ghToken,
    );
    if (pull.state === "open") open.add(pr);
  }

  const plan = planCleanup(workerNames, branches.branches, (pr) => open.has(pr), queues);
  for (const name of plan.workers) {
    console.log(`${dryRun ? "would delete" : "deleting"} Worker ${name}`);
    if (!dryRun) await request(`${cf}/${name}?force=true`, { method: "DELETE" }, cfToken);
  }
  for (const queue of plan.queues) {
    console.log(`${dryRun ? "would delete" : "deleting"} queue ${queue.name}`);
    if (!dryRun) await request(`${cfQueues}/${queue.id}`, { method: "DELETE" }, cfToken);
  }
  for (const branch of plan.branches) {
    console.log(`${dryRun ? "would delete" : "deleting"} Neon branch ${branch.name}`);
    if (!dryRun) await request(`${neon}/${branch.id}`, { method: "DELETE" }, neonKey);
  }
  if (plan.workers.length + plan.queues.length + plan.branches.length === 0) {
    console.log("nothing to clean up");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
