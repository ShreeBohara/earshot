// The recap's live check (Phase 5 spec §4.10 and WP10, "Live check, with your approval"; ADR-0037):
// one recap on each provider, on keys from the local environment, under $0.01 in all. It answers
// Appendix B's question 7 (does Haiku 5.5 make the forced `submit_recap` call at its default
// effort?) and the same for gpt-oss-20b, and times each recap against the 15 s deadline.
//
// This module is the check's logic, so a $0 test can drive it on the recap cassettes; the command
// is scripts/recap-live-check.ts, and only a person runs it. In order:
//
// - The plan prices the run before anything else, and refuses unless the estimate is within the
//   budget and the budget within the $0.01 cap. Only then does it look at the environment: the
//   EARSHOT_RECAP_LIVE flag set to "1", and each provider's key in the live eval's variables
//   (EVAL_ANTHROPIC_KEY, EVAL_GROQ_KEY). No key is read until the estimate has passed.
// - The estimate is the worst case: the retry policy's two writes, each a call and its validation
//   retry, so four calls per provider at the price table's rates, a quarter more.
// - The run is production's: `createRecapper` on the provider's direct endpoint, `runRecap` with
//   `RECAP_RETRY_POLICY` (the same 15 s deadline SessionDO uses), the checks in code. The debrief
//   is a synthetic one of the 200 (d002 by default, which maps MEDDIC), and its request is the
//   recap eval's, so the answer can be compared with that debrief's cassette. Before each
//   provider it checks the spend so far plus that provider's estimate is still within the budget.
// - What it reports is numbers and fixed codes: never a key, a prompt, or a sentence's text.
import {
  createRecapper,
  findLlmPrice,
  LLM_MODELS,
  LLM_PRICES,
  llmCostUsd,
  RECAP_RETRY_POLICY,
  type RecapResult,
  roundUsd,
  runRecap,
  ZERO_USAGE,
} from "@earshot/agent";
import { RECORD_KEY_VARIABLES } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import type { DebriefScript } from "../schema";
import { recapTokens, SMOKE_ESTIMATE } from "../smoke/budget";
import { recapLensOf, recapScriptProposals, recapScriptUtterances } from "./cassettes";

/** The flag that turns the live check on, beside each provider's key. */
export const RECAP_LIVE_FLAG = "EARSHOT_RECAP_LIVE";
/** Where each provider's key comes from: the live eval's variables (spec §2.2). */
export const RECAP_LIVE_KEYS: Readonly<Record<LlmProvider, string>> = RECORD_KEY_VARIABLES;
/** The spec's cap for the whole check (§4.10): under $0.01. */
export const RECAP_LIVE_MAX_USD = 0.01;
/** The debrief recapped: a synthetic one, whose lens by rotation is MEDDIC. */
export const RECAP_LIVE_SCRIPT = "d002";
/** The calls priced per provider: two writes (the retry policy), each with its validation retry. */
export const RECAP_LIVE_WORST_CALLS = RECAP_RETRY_POLICY.maxAttempts * 2;

export interface RecapLiveEstimate {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly usd: number;
}

/** One provider's recap at its worst: every call priced, a quarter more. */
export function estimateRecapLive(provider: LlmProvider, script: DebriefScript): RecapLiveEstimate {
  const model = LLM_MODELS[provider];
  const price = findLlmPrice(LLM_PRICES, provider, model);
  if (!price) throw new Error(`The price table has no row for ${provider}/${model}.`);
  const tokens = recapTokens(script);
  const call = llmCostUsd(
    {
      ...ZERO_USAGE,
      inputTokens: tokens.input,
      outputTokens: tokens.output + SMOKE_ESTIMATE.reasoningTokens[provider],
    },
    price,
  );
  return {
    provider,
    model,
    usd: roundUsd(call * RECAP_LIVE_WORST_CALLS * SMOKE_ESTIMATE.safetyFactor),
  };
}

export interface RecapLivePlanInput {
  readonly providers: readonly LlmProvider[];
  readonly script: DebriefScript;
  readonly budgetUsd: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface PlanBase {
  readonly providers: readonly LlmProvider[];
  readonly script: DebriefScript;
  readonly budgetUsd: number;
  readonly estimates: readonly RecapLiveEstimate[];
  readonly estimateUsd: number;
}

export type RecapLivePlan =
  | (PlanBase & {
      readonly ok: true;
      readonly keys: Readonly<Partial<Record<LlmProvider, string>>>;
    })
  | (PlanBase & { readonly ok: false; readonly refusal: string });

const usd = (amount: number) => `$${amount.toFixed(6)}`;

/**
 * Prices the check, then decides whether it may start. The order is the point: the budget and the
 * estimate are checked before the environment is, and a key is read only once all else passes.
 */
export function planRecapLive(input: RecapLivePlanInput): RecapLivePlan {
  const providers = [...new Set(input.providers)];
  const estimates = providers.map((provider) => estimateRecapLive(provider, input.script));
  const estimateUsd = roundUsd(estimates.reduce((sum, estimate) => sum + estimate.usd, 0));
  const base: PlanBase = {
    providers,
    script: input.script,
    budgetUsd: input.budgetUsd,
    estimates,
    estimateUsd,
  };
  const refuse = (refusal: string): RecapLivePlan => ({ ...base, ok: false, refusal });
  if (providers.length === 0) return refuse("No provider was chosen: anthropic, groq, or all.");
  if (
    !Number.isFinite(input.budgetUsd) ||
    input.budgetUsd <= 0 ||
    input.budgetUsd > RECAP_LIVE_MAX_USD
  ) {
    return refuse(
      `The budget is a positive number of dollars, at most ${usd(RECAP_LIVE_MAX_USD)}.`,
    );
  }
  if (estimateUsd > input.budgetUsd) {
    return refuse(
      `The estimate, ${usd(estimateUsd)}, is over the budget, ${usd(input.budgetUsd)}: not starting.`,
    );
  }
  if (input.env[RECAP_LIVE_FLAG] !== "1") {
    return refuse(
      `The live check is off. It spends money, so it needs ${RECAP_LIVE_FLAG}=1 and ${providers
        .map((provider) => RECAP_LIVE_KEYS[provider])
        .join(" and ")}.`,
    );
  }
  const keys: Partial<Record<LlmProvider, string>> = {};
  const missing: string[] = [];
  for (const provider of providers) {
    const key = input.env[RECAP_LIVE_KEYS[provider]]?.trim() ?? "";
    if (key === "") missing.push(RECAP_LIVE_KEYS[provider]);
    else keys[provider] = key;
  }
  if (missing.length > 0) return refuse(`${missing.join(" and ")} isn't set.`);
  return { ...base, ok: true, keys };
}

/** One provider's recap, as numbers and fixed codes. */
export interface RecapLiveResult {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly outcome: RecapResult["recap"]["outcome"];
  readonly reason: RecapResult["recap"]["reason"];
  /** The call failure's code and detail, fixed strings, when there was one. */
  readonly failure: string | null;
  readonly attempts: number;
  /** From the start of `runRecap` to its end: what SessionDO's 15 s deadline bounds. */
  readonly wallMs: number;
  readonly withinDeadline: boolean;
  readonly written: number;
  readonly kept: number;
  readonly withEvidence: number;
  readonly dropped: number;
  readonly weak: number;
  readonly headline: boolean;
  readonly lens: string | null;
  readonly lensFields: number;
  readonly lensMentioned: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface RecapLiveReport {
  readonly script: string;
  readonly lens: string | null;
  readonly budgetUsd: number;
  readonly estimateUsd: number;
  readonly spentUsd: number;
  readonly results: readonly RecapLiveResult[];
  /** Why a provider wasn't run: the spend so far and its estimate passed the budget. */
  readonly stopped: string | null;
  readonly passed: boolean;
}

export interface RunRecapLiveOptions {
  /** Each provider's fetch: the real one live, a cassette's in tests. */
  readonly fetchFor?: (provider: LlmProvider) => typeof globalThis.fetch;
  readonly now?: () => number;
  /** After each provider, e.g. to save its recording. */
  readonly onResult?: (result: RecapLiveResult) => void | Promise<void>;
}

/** A recap's numbers. Text never leaves: only counts, codes, and timings. */
export function recapLiveResult(
  provider: LlmProvider,
  model: string,
  result: RecapResult,
  wallMs: number,
): RecapLiveResult {
  const { recap } = result;
  const lensFields = recap.lens?.fields ?? [];
  return {
    provider,
    model,
    outcome: recap.outcome,
    reason: recap.reason,
    failure: result.failure ? `${result.failure.code}:${result.failure.detail}` : null,
    attempts: result.attempts,
    wallMs: Math.round(wallMs),
    withinDeadline: wallMs <= RECAP_RETRY_POLICY.deadlineMs,
    written: result.trace.length,
    kept: recap.sentences.length,
    withEvidence: recap.sentences.filter((sentence) => sentence.evidence.length > 0).length,
    dropped: recap.dropped,
    weak: recap.sentences.filter((sentence) => sentence.weakSupport).length,
    headline: recap.sentences.some((sentence) => sentence.kind === "headline"),
    lens: recap.lens?.id ?? null,
    lensFields: lensFields.length,
    lensMentioned: lensFields.filter((field) => field.evidence !== null).length,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    costUsd: result.usage?.costUsd ?? 0,
  };
}

/** A provider passes with a recap written in time, a headline, and evidence on every kept sentence. */
export function recapLivePassed(result: RecapLiveResult): boolean {
  return (
    result.outcome === "created" &&
    result.headline &&
    result.withinDeadline &&
    result.withEvidence === result.kept
  );
}

/** Runs a plan that passed: one recap per provider, in order, the budget checked before each. */
export async function runRecapLive(
  plan: Extract<RecapLivePlan, { ok: true }>,
  options: RunRecapLiveOptions = {},
): Promise<RecapLiveReport> {
  const now = options.now ?? (() => performance.now());
  const results: RecapLiveResult[] = [];
  let spentUsd = 0;
  let stopped: string | null = null;
  for (const estimate of plan.estimates) {
    if (spentUsd + estimate.usd > plan.budgetUsd) {
      stopped = `${estimate.provider} wasn't run: ${usd(spentUsd)} spent and its estimate, ${usd(estimate.usd)}, would pass the budget.`;
      break;
    }
    const key = plan.keys[estimate.provider] ?? "";
    const fetch = options.fetchFor?.(estimate.provider);
    const recapper = createRecapper({
      provider: estimate.provider,
      ...(fetch ? { fetch } : {}),
    });
    const started = now();
    const result = await runRecap({
      recapper,
      utterances: recapScriptUtterances(plan.script),
      proposals: recapScriptProposals(plan.script),
      lens: recapLensOf(plan.script),
      apiKey: key,
      signal: new AbortController().signal,
      policy: RECAP_RETRY_POLICY,
    });
    const row = recapLiveResult(estimate.provider, recapper.model, result, now() - started);
    results.push(row);
    spentUsd = roundUsd(spentUsd + row.costUsd);
    await options.onResult?.(row);
  }
  return {
    script: plan.script.id,
    lens: recapLensOf(plan.script),
    budgetUsd: plan.budgetUsd,
    estimateUsd: plan.estimateUsd,
    spentUsd,
    results,
    stopped,
    passed: stopped === null && results.length > 0 && results.every(recapLivePassed),
  };
}

/** The report as a table, for the terminal or a PR comment. */
export function recapLiveMarkdown(report: RecapLiveReport): string {
  const lines = [
    `The recap's live check on ${report.script} (${report.lens ?? "no lens"}): ${report.passed ? "passed" : "failed"}.`,
    "",
    "| Provider | Outcome | Attempts | Time | Kept | With evidence | Dropped | Weak | Headline | Lens | Tokens in/out | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    const outcome = r.reason
      ? `${r.outcome} (${r.reason}${r.failure ? `, ${r.failure}` : ""})`
      : r.outcome;
    const lens = r.lens ? `${r.lens}: ${r.lensMentioned} of ${r.lensFields} mentioned` : "none";
    lines.push(
      `| ${r.provider}/${r.model} | ${outcome} | ${r.attempts} | ${r.wallMs} ms${r.withinDeadline ? "" : " (past 15 s)"} | ${r.kept} of ${r.written} | ${r.withEvidence} of ${r.kept} | ${r.dropped} | ${r.weak} | ${r.headline ? "yes" : "no"} | ${lens} | ${r.inputTokens}/${r.outputTokens} | ${usd(r.costUsd)} |`,
    );
  }
  lines.push("");
  if (report.stopped) lines.push(report.stopped, "");
  lines.push(
    `Estimated at most ${usd(report.estimateUsd)}; spent ${usd(report.spentUsd)} of a budget of ${usd(report.budgetUsd)}.`,
  );
  return lines.join("\n");
}
