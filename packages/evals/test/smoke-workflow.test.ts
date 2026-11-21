// The live smoke workflow's structure (Phase 4 WP11 step 3; gate G3b): skipped cleanly while
// EVAL_SMOKE_ENABLED is unset, on same-repository pull requests only, its key in the eval-smoke
// environment and in no step that doesn't need it, least privilege, actions pinned by commit, and
// triggered on what the spec lists. Its `if:` conditions are evaluated here by a small evaluator
// of GitHub's expression syntax (comparisons, `!`, `&&`, `||`, and context lookups).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = new URL("../../../.github/workflows/eval-smoke.yml", import.meta.url);
const TEXT = readFileSync(WORKFLOW, "utf8");

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly if?: string;
  readonly needs?: string | string[];
  readonly environment?: string;
  readonly permissions?: unknown;
  readonly env?: Record<string, string>;
  readonly steps: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, Job>;
}
const workflow = parse(TEXT) as Workflow;
const jobs = workflow.jobs;

/** A GitHub expression as a workflow writes it, `${{ … }}`. */
const gh = (inner: string) => `\${{ ${inner} }}`;

// --- A small evaluator of GitHub Actions expressions ------------------------------------------

type Value = string | number | boolean | null | Record<string, unknown>;

/** Tokens: strings, numbers, words (true, false, null, and dotted context paths), operators. */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === " " || char === "\n" || char === "\t") {
      i++;
    } else if (char === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= source.length) throw new Error(`unterminated string in ${source}`);
        if (source[j] === "'" && source[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (source[j] === "'") break;
        else text += source[j++];
      }
      tokens.push(`'${text}`);
      i = j + 1;
    } else if (["==", "!=", "&&", "||"].includes(source.slice(i, i + 2))) {
      tokens.push(source.slice(i, i + 2));
      i += 2;
    } else if ("()!".includes(char)) {
      tokens.push(char);
      i++;
    } else {
      let j = i;
      while (j < source.length && /[\w.-]/.test(source[j] as string)) j++;
      if (j === i) throw new Error(`unexpected ${char} in ${source}`);
      tokens.push(source.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function lookup(path: string, context: Record<string, unknown>): Value {
  let at: unknown = context;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[key];
  }
  return at === undefined ? null : (at as Value);
}

function truthy(value: Value): boolean {
  return !(value === false || value === null || value === 0 || value === "" || Number.isNaN(value));
}

function toNumber(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return Number.NaN;
}

/** GitHub's loose equality: strings compare ignoring case; other mixes compare as numbers. */
function equal(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === "object" && a !== null) return a === b;
  return toNumber(a) === toNumber(b);
}

function evaluate(expression: string, context: Record<string, unknown>): Value {
  const source = expression
    .trim()
    .replace(/^\$\{\{/, "")
    .replace(/\}\}$/, "");
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++] as string;
  const primary = (): Value => {
    const token = next();
    if (token === "(") {
      const value = or();
      if (next() !== ")") throw new Error(`missing ) in ${source}`);
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^\d/.test(token)) return Number(token);
    return lookup(token, context);
  };
  const comparison = (): Value => {
    let left = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = next();
      const right = primary();
      left = op === "==" ? equal(left, right) : !equal(left, right);
    }
    return left;
  };
  const and = (): Value => {
    let left = comparison();
    while (peek() === "&&") {
      next();
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): Value => {
    let left = and();
    while (peek() === "||") {
      next();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${source}`);
  return value;
}

/** GitHub's contexts for an event, a repository variable, and the `changes` job's output. */
function context(options: {
  event: "pull_request" | "workflow_dispatch";
  enabled?: string;
  fork?: boolean;
  smoke?: string;
  baseline?: boolean;
}): Record<string, unknown> {
  return {
    vars: options.enabled === undefined ? {} : { EVAL_SMOKE_ENABLED: options.enabled },
    github: {
      event_name: options.event,
      repository: "ShreeBohara/earshot",
      event:
        options.event === "pull_request"
          ? {
              pull_request: {
                head: {
                  repo: {
                    full_name: options.fork ? "someone/earshot" : "ShreeBohara/earshot",
                  },
                },
              },
            }
          : { inputs: { baseline: options.baseline ?? false } },
    },
    inputs: options.event === "workflow_dispatch" ? { baseline: options.baseline ?? false } : {},
    needs: { changes: { outputs: { smoke: options.smoke ?? "" } } },
  };
}

/** Whether a job runs: its `needs` ran, and its `if` holds (implicitly `success() && …`). */
function runs(name: string, ctx: Record<string, unknown>, ran: Set<string>): boolean {
  const job = jobs[name] as Job;
  const needs = job.needs === undefined ? [] : [job.needs].flat();
  if (!needs.every((need) => ran.has(need))) return false;
  return job.if === undefined ? true : truthy(evaluate(job.if, ctx));
}

/** The jobs that run for a context, in order. */
function jobsThatRun(ctx: Record<string, unknown>): string[] {
  const ran = new Set<string>();
  for (const name of Object.keys(jobs)) if (runs(name, ctx, ran)) ran.add(name);
  return [...ran];
}

// --- The tests ---------------------------------------------------------------------------------

describe("the expression evaluator", () => {
  it("reads GitHub's comparisons as GitHub does", () => {
    const ctx = { vars: { A: "TRUE" }, x: { y: "a" } };
    expect(evaluate("vars.A == 'true'", ctx)).toBe(true);
    expect(evaluate("vars.MISSING == 'true'", ctx)).toBe(false);
    expect(evaluate("vars.MISSING != 'pull_request' && x.y == 'a'", ctx)).toBe(true);
    expect(evaluate("!(x.y == 'a') || 'it''s'", ctx)).toBe("it's");
    expect(evaluate(gh("x.y"), ctx)).toBe("a");
  });
});

describe("the eval-smoke workflow", () => {
  it("is skipped, every job of it, while EVAL_SMOKE_ENABLED is unset or anything but true", () => {
    for (const enabled of [undefined, "", "false", "yes", "1"]) {
      for (const event of ["pull_request", "workflow_dispatch"] as const) {
        expect(
          jobsThatRun(context({ event, enabled, smoke: "true" })),
          `${enabled} ${event}`,
        ).toEqual([]);
      }
    }
  });

  it("runs on a same-repository pull request that touches what it measures, and by hand", () => {
    expect(jobsThatRun(context({ event: "pull_request", enabled: "true", smoke: "true" }))).toEqual(
      ["changes", "eval-smoke"],
    );
    expect(
      jobsThatRun(context({ event: "workflow_dispatch", enabled: "true", smoke: "true" })),
    ).toEqual(["changes", "eval-smoke"]);
    // GitHub compares strings ignoring case.
    expect(jobsThatRun(context({ event: "pull_request", enabled: "True", smoke: "true" }))).toEqual(
      ["changes", "eval-smoke"],
    );
  });

  it("skips the live run when the pull request touches nothing it measures, and never runs for a fork", () => {
    expect(
      jobsThatRun(context({ event: "pull_request", enabled: "true", smoke: "false" })),
    ).toEqual(["changes"]);
    expect(
      jobsThatRun(context({ event: "pull_request", enabled: "true", fork: true, smoke: "true" })),
    ).toEqual([]);
  });

  it("triggers on every pull request, so a required check always reports, and by hand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    // A paths or branches filter would leave a required check pending when the workflow doesn't run.
    expect(workflow.on.pull_request).toBeNull();
  });

  it("has the spec's condition on every job, and the eval-smoke job the required check can name", () => {
    const condition =
      "vars.EVAL_SMOKE_ENABLED == 'true' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
    expect(Object.keys(jobs)).toEqual(["changes", "eval-smoke"]);
    for (const [name, job] of Object.entries(jobs)) expect(job.if, name).toContain(condition);
    expect(jobs["eval-smoke"]?.needs).toBe("changes");
  });

  it("decides what to run on everything the live run executes or reads, and its own", () => {
    const run = jobs.changes?.steps.find((step) => step.id === "paths")?.run ?? "";
    const quoted = /pattern='([^']+)'/.exec(run)?.[1];
    if (!quoted) throw new Error("no path pattern");
    const pattern = new RegExp(quoted);
    for (const path of [
      "packages/agent/src/prompt.ts",
      "packages/agent/src/schema.ts",
      "packages/understanding/src/link/decide.ts",
      "packages/understanding/package.json",
      "packages/evals/smoke.json",
      "packages/evals/src/smoke/run.ts",
      "packages/evals/scripts/eval-smoke.ts",
      "packages/evals/baselines/smoke-anthropic.json",
      ".github/workflows/eval-smoke.yml",
      // What the smoke runner and its scoring share with WP10's offline eval, and its inputs.
      "packages/evals/src/understanding/run.ts",
      "packages/evals/src/understanding/metrics.ts",
      "packages/evals/src/schema.ts",
      "packages/evals/scripts/smoke-io.ts",
      "packages/evals/debriefs/d003.json",
      "packages/evals/debriefs/generated/d033.json",
      "packages/core/src/contracts/session-protocol.ts",
      "packages/demo-crm/src/companies.ts",
      "packages/voice/src/prices.ts",
      // The recap each script gets (Phase 5 WP10): its prompt, lens files, scoring, and cassettes.
      "packages/agent/src/recap/prompt.ts",
      "packages/agent/src/recap/lenses/meddic.json",
      "packages/evals/src/smoke/recap.ts",
      "packages/evals/src/recap/cassettes.ts",
      "packages/evals/scripts/recap-io.ts",
    ]) {
      expect(pattern.test(path), path).toBe(true);
    }
    for (const path of [
      "packages/agent/test/requests.test.ts",
      "packages/agent/cassettes/anthropic.json",
      "packages/evals/test/understanding.test.ts",
      "packages/evals/cassettes/understanding/anthropic.json",
      "packages/evals/baselines/understanding.json",
      "packages/voice/src/engines/debrief/debrief-engine.ts",
      "apps/web/app/page.tsx",
      "README.md",
    ]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });

  it("keeps its key in the eval-smoke environment, in the steps that call the model and no other", () => {
    const smoke = jobs["eval-smoke"] as Job;
    expect(smoke.environment).toBe("eval-smoke");
    expect(TEXT.match(/secrets\.[A-Z_]+/g)?.sort()).toEqual([
      "secrets.EVAL_SMOKE_ANTHROPIC_KEY",
      "secrets.EVAL_SMOKE_ANTHROPIC_KEY",
      "secrets.EVAL_SMOKE_GROQ_KEY",
      "secrets.EVAL_SMOKE_GROQ_KEY",
    ]);
    for (const job of Object.values(jobs)) {
      expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
      for (const step of job.steps) {
        expect(step.run ?? "").not.toContain("secrets.");
        const keyed = JSON.stringify(step.env ?? {}).includes("secrets.");
        const calls = /eval:smoke --check|baseline:smoke/.test(step.run ?? "");
        expect(keyed, step.name ?? step.uses ?? "a step").toBe(calls);
      }
    }
    // The budget guard runs first, with no key, and refuses before anything is spent.
    const names = smoke.steps.map((step) => step.run ?? "");
    const guard = names.findIndex((run) => run.includes("eval:smoke --estimate"));
    const live = names.findIndex((run) => run.includes("eval:smoke --check"));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(live);
  });

  it("reports to the job summary and an artifact, and records a baseline only by hand", () => {
    const steps = jobs["eval-smoke"]?.steps ?? [];
    const live = steps.find((step) => step.run?.includes("eval:smoke --check"));
    const baseline = steps.find((step) => step.run?.includes("baseline:smoke"));
    expect(live?.run).toContain('--summary "$GITHUB_STEP_SUMMARY"');
    expect(live?.run).toContain("--out");
    expect(live?.if).toBe(gh("!inputs.baseline"));
    expect(baseline?.if).toBe(gh("inputs.baseline"));
    const ctxPr = context({ event: "pull_request", enabled: "true", smoke: "true" });
    expect(truthy(evaluate(live?.if ?? "", ctxPr))).toBe(true);
    expect(truthy(evaluate(baseline?.if ?? "", ctxPr))).toBe(false);
    const ctxBaseline = context({
      event: "workflow_dispatch",
      enabled: "true",
      smoke: "true",
      baseline: true,
    });
    expect(truthy(evaluate(live?.if ?? "", ctxBaseline))).toBe(false);
    expect(truthy(evaluate(baseline?.if ?? "", ctxBaseline))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
  });

  it("reads the repository, and nothing more", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(jobs)) expect(job.permissions).toBeUndefined();
  });

  it("pins every action to a full commit, with its version beside it", () => {
    const uses = TEXT.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
  });
});
