// The recap eval (Phase 5 WP10 step 6; ADR-0037): each debrief's recap cassette replayed through
// the real adapter, `runRecap`, and the checks in code, then scored against the labels. $0 and
// deterministic. CI's `checks` job gates it (`eval:recap --check`), and fails unless, for both
// providers:
//
// - 100% of kept sentences carry evidence;
// - every seeded bad sentence was dropped;
// - every recap has a headline;
// - every ground-truth sentence was kept (the checks mustn't drop what the rep did say);
// - every invented lens quote came back "not mentioned";
// - no request missed its cassette;
// - and, against baselines/recap.json, the weak-support share hasn't risen more than 3 points
//   (target), on the scripts and labels the baseline was recorded on.
//
// The report adds what the spec says to report without a threshold: the drop rate and the cost.
import { createRecapper, type RecapResult, runRecap } from "@earshot/agent";
import { type Cassette, createCassetteFetch, SCENARIO_API_KEY } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { z } from "zod";
import type { DebriefScript } from "../schema";
import {
  groundTruthSentences,
  type RecapLabels,
  recapLensOf,
  recapScriptProposals,
  recapScriptUtterances,
} from "./cassettes";

/** One script's recap, replayed. */
export interface RecapRun {
  readonly script: string;
  readonly result: RecapResult;
  /** Requests the cassette couldn't answer, and interactions it had left over. */
  readonly misses: number;
  readonly unplayed: number;
}

/** Deterministic ids for replays. */
function counterIds(): () => string {
  let n = 0;
  return () => `01a1c6e7-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

/** Replays a script's recap cassette through the real adapter and `runRecap`. */
export async function runRecapScript(
  provider: LlmProvider,
  script: DebriefScript,
  cassette: Cassette,
): Promise<RecapRun> {
  const fetch = createCassetteFetch(cassette);
  const result = await runRecap({
    recapper: createRecapper({ provider, fetch: fetch as typeof globalThis.fetch, now: () => 0 }),
    utterances: recapScriptUtterances(script),
    proposals: recapScriptProposals(script),
    lens: recapLensOf(script),
    apiKey: SCENARIO_API_KEY,
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async () => {},
    newId: counterIds(),
    random: () => 0.5,
  });
  return { script: script.id, result, misses: fetch.misses.length, unplayed: fetch.remaining() };
}

export interface Count {
  readonly n: number;
  readonly of: number;
  /** n ÷ of, or null when there's nothing to count. */
  readonly rate: number | null;
}

const count = (n: number, of: number): Count => ({ n, of, rate: of === 0 ? null : n / of });

export interface RecapMetrics {
  readonly recaps: number;
  /** Recaps the replay ended `created`; the rest failed or were skipped. */
  readonly created: number;
  /** Recaps with exactly one kept headline. */
  readonly headlines: Count;
  /** Sentences the cassettes' model wrote. */
  readonly written: number;
  /** Kept sentences with at least one piece of evidence, of all kept. */
  readonly evidence: Count;
  /** Sentences dropped for no located quote, of all written. */
  readonly dropped: Count;
  /** Headlines after the first, left out. */
  readonly extraHeadlines: number;
  /** Kept sentences marked weak support, of all kept. */
  readonly weakSupport: Count;
  /** Seeded bad sentences dropped, of all seeded. */
  readonly badDropped: Count;
  /** Ground-truth sentences kept, of all of them. */
  readonly goodKept: Count;
  /** Lens fields with a located quote, of all lens fields. */
  readonly lensMentioned: Count;
  /** Invented lens quotes that came back "not mentioned", of all invented. */
  readonly badLensUnmentioned: Count;
  /** Seeded items that got through, and ground truth that didn't: script and position. */
  readonly leaks: readonly string[];
  readonly lost: readonly string[];
  readonly misses: number;
  readonly unplayed: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    /** Per recap, on average. */
    readonly costPerRecapUsd: number;
  };
}

/** The recap eval's numbers over every replayed script, against the labels. */
export function recapMetrics(
  runs: readonly RecapRun[],
  scripts: readonly DebriefScript[],
  labels: RecapLabels,
): RecapMetrics {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  let created = 0;
  let headlines = 0;
  let written = 0;
  let kept = 0;
  let withEvidence = 0;
  let dropped = 0;
  let extraHeadlines = 0;
  let weak = 0;
  let badSeeded = 0;
  let badDropped = 0;
  let good = 0;
  let goodKept = 0;
  let lensFields = 0;
  let lensMentioned = 0;
  let badLens = 0;
  let badLensUnmentioned = 0;
  let misses = 0;
  let unplayed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const leaks: string[] = [];
  const lost: string[] = [];
  for (const run of runs) {
    const { recap, trace, usage } = run.result;
    misses += run.misses;
    unplayed += run.unplayed;
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    costUsd += usage?.costUsd ?? 0;
    if (recap.outcome === "created") created += 1;
    if (recap.sentences.filter((sentence) => sentence.kind === "headline").length === 1) {
      headlines += 1;
    }
    written += trace.length;
    kept += recap.sentences.length;
    withEvidence += recap.sentences.filter((sentence) => sentence.evidence.length > 0).length;
    dropped += recap.dropped;
    extraHeadlines += trace.filter((item) => item.fate === "extra_headline").length;
    weak += recap.sentences.filter((sentence) => sentence.weakSupport).length;
    const fate = new Map(trace.map((item) => [item.index, item.fate]));
    const seeded = labels.sentences.filter((item) => item.script === run.script);
    const seededAt = new Set(seeded.map((item) => item.index));
    for (const item of seeded) {
      badSeeded += 1;
      if (fate.get(item.index) === "no_quote") badDropped += 1;
      else leaks.push(`${run.script} sentence ${item.index + 1}`);
    }
    const script = byId.get(run.script);
    const truths = script ? groundTruthSentences(script).length : 0;
    // The ground truth's sentences are every position the labels didn't seed.
    let position = 0;
    for (let truth = 0; truth < truths; truth++) {
      while (seededAt.has(position)) position += 1;
      good += 1;
      if (fate.get(position) === "kept") goodKept += 1;
      else lost.push(`${run.script} sentence ${position + 1}`);
      position += 1;
    }
    for (const field of recap.lens?.fields ?? []) {
      lensFields += 1;
      if (field.evidence !== null) lensMentioned += 1;
      const invented = labels.lens.find(
        (item) => item.script === run.script && item.field === field.field,
      );
      if (invented) {
        badLens += 1;
        if (field.quote === null && field.evidence === null) badLensUnmentioned += 1;
        else leaks.push(`${run.script} lens ${field.field}`);
      }
    }
  }
  return {
    recaps: runs.length,
    created,
    headlines: count(headlines, runs.length),
    written,
    evidence: count(withEvidence, kept),
    dropped: count(dropped, written),
    extraHeadlines,
    weakSupport: count(weak, kept),
    badDropped: count(badDropped, badSeeded),
    goodKept: count(goodKept, good),
    lensMentioned: count(lensMentioned, lensFields),
    badLensUnmentioned: count(badLensUnmentioned, badLens),
    leaks,
    lost,
    misses,
    unplayed,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: Math.round(costUsd * 1e9) / 1e9,
      costPerRecapUsd: runs.length === 0 ? 0 : Math.round((costUsd / runs.length) * 1e9) / 1e9,
    },
  };
}

/** The gate's targets. */
export const RECAP_GATE = {
  /** The most the weak-support share may rise above the baseline's before it fails. */
  maxWeakSupportRise: 0.03,
} as const;

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 1_000_000) / 1_000_000;

/** The numbers a baseline keeps, per provider. */
export const RecapSummary = z.strictObject({
  recaps: z.int().nonnegative(),
  written: z.int().nonnegative(),
  kept: z.int().nonnegative(),
  dropped: z.int().nonnegative(),
  dropRate: z.number().min(0).max(1).nullable(),
  weakSupportShare: z.number().min(0).max(1).nullable(),
  lensMentionedShare: z.number().min(0).max(1).nullable(),
  costPerRecapUsd: z.number().nonnegative(),
});
export type RecapSummary = z.infer<typeof RecapSummary>;

export function summarizeRecap(metrics: RecapMetrics): RecapSummary {
  return {
    recaps: metrics.recaps,
    written: metrics.written,
    kept: metrics.evidence.of,
    dropped: metrics.dropped.n,
    dropRate: round(metrics.dropped.rate),
    weakSupportShare: round(metrics.weakSupport.rate),
    lensMentionedShare: round(metrics.lensMentioned.rate),
    costPerRecapUsd: metrics.usage.costPerRecapUsd,
  };
}

export const RECAP_BASELINE_FORMAT = 1;

export const RecapBaseline = z.strictObject({
  format: z.literal(RECAP_BASELINE_FORMAT),
  /** SHA-256 over the 200 scripts' files, and over the labels file, it was recorded on. */
  scriptsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  labelsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.iso.date(),
  providers: z.strictObject({ anthropic: RecapSummary, groq: RecapSummary }),
});
export type RecapBaseline = z.infer<typeof RecapBaseline>;

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

/** The gate's failures for one provider's run; empty when it passes. */
export function recapGateFailures(
  provider: LlmProvider,
  metrics: RecapMetrics,
  baseline: RecapSummary | null,
): string[] {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(`${provider}: ${message}`);
  if (metrics.misses > 0 || metrics.unplayed > 0) {
    fail(
      `${metrics.misses} requests missed their cassette and ${metrics.unplayed} interactions went unplayed: the cassettes are stale (pnpm --filter @earshot/evals recap:gen)`,
    );
  }
  if (metrics.created !== metrics.recaps) {
    fail(`${metrics.recaps - metrics.created} of ${metrics.recaps} recaps weren't created`);
  }
  if (metrics.evidence.n !== metrics.evidence.of) {
    fail(
      `${metrics.evidence.of - metrics.evidence.n} of ${metrics.evidence.of} kept sentences carry no evidence (${pct(metrics.evidence.rate)}; the gate is 100%)`,
    );
  }
  if (metrics.badDropped.n !== metrics.badDropped.of) {
    fail(
      `${metrics.badDropped.of - metrics.badDropped.n} of ${metrics.badDropped.of} seeded bad sentences were kept`,
    );
  }
  if (metrics.headlines.n !== metrics.headlines.of) {
    fail(
      `${metrics.headlines.of - metrics.headlines.n} of ${metrics.headlines.of} recaps have no headline`,
    );
  }
  if (metrics.goodKept.n !== metrics.goodKept.of) {
    fail(
      `${metrics.goodKept.of - metrics.goodKept.n} of ${metrics.goodKept.of} ground-truth sentences were dropped`,
    );
  }
  if (metrics.badLensUnmentioned.n !== metrics.badLensUnmentioned.of) {
    fail(
      `${metrics.badLensUnmentioned.of - metrics.badLensUnmentioned.n} of ${metrics.badLensUnmentioned.of} invented lens quotes weren't "not mentioned"`,
    );
  }
  const now = metrics.weakSupport.rate;
  const then = baseline?.weakSupportShare ?? null;
  if (then !== null && now !== null && now > then + RECAP_GATE.maxWeakSupportRise + 1e-9) {
    fail(
      `regression: the weak-support share ${pct(now)} is more than 3 points above the baseline's ${pct(then)}`,
    );
  }
  return failures;
}
