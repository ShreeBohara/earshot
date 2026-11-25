// The live smoke eval's budget guard (Phase 4 WP11 step 2; ADR-0031), in two halves:
//
// - Before a run, `estimateSmokeSpend` prices every turn's request from what it will send (the
//   tool definition, the system prompt, the transcript) and what the model should answer (the
//   script's proposals as tool input), at the price table's rates, then adds a quarter. The CLI
//   refuses to start above EVAL_SMOKE_BUDGET_USD.
// - During the run, `createBudgetMeter` sums each call's measured cost: the provider's reported
//   usage at the same rates (`llmCostUsd`, which the extractor already applies per call). Once the
//   sum passes the budget it trips, the runner stops, and the run fails as incomplete.
//
// Tokens are estimated from characters, at 2.5 a token. Haiku 5.5's tokenizer counts about 30%
// more tokens than Haiku 4.5's for the same text (the claude-api skill's migration notes), and
// the tool schema is JSON, denser than prose, so the ratio errs toward more tokens. The exact
// count needs Anthropic's count_tokens endpoint, which is a live call. Each run's report shows the
// measured usage beside the estimate.
//
// Each script's recap (Phase 5 WP10) is one more request, priced the same way: the recap's tool
// definition, its instructions (with the script's lens), the transcript and the ground truth's
// proposals, and an answer the size of the ground truth's recap, a quarter more, plus reasoning on
// Groq. Recaps never use the prompt cache: one per script can't reuse a 5-minute cache (P5 §5).
//
// With the prompt cache on (Anthropic), the estimate follows the cache plan: the run's first call
// writes the tool definition (1.25x) and every later call reads it (0.1x); each script's first
// call writes its system prompt and its later calls read it. The tool definition alone is about
// 13,000 characters, so most of each request is a cache read. The same run with no cache hits is
// reported too: that's what the in-run guard would meet if caching didn't take.
import {
  buildPrompt,
  type LlmPriceRow,
  llmCostUsd,
  recapLens,
  roundUsd,
  SUBMIT_PROPOSALS,
  SUBMIT_PROPOSALS_DESCRIPTION,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  type TokenUsage,
  ZERO_USAGE,
} from "@earshot/agent";
import {
  buildRecapPrompt,
  SUBMIT_RECAP,
  SUBMIT_RECAP_DESCRIPTION,
  SUBMIT_RECAP_JSON_SCHEMA,
} from "@earshot/agent/recap";
import { toolProposal } from "../generate";
import {
  groundTruthLens,
  groundTruthSentences,
  recapLensOf,
  recapScriptProposals,
  recapScriptUtterances,
} from "../recap/cassettes";
import type { DebriefScript } from "../schema";
import { demoEntity } from "../session";
import { understandingUtterances } from "../understanding/cassettes";

/** The estimate's assumptions. */
export const SMOKE_ESTIMATE = {
  /** Characters per token: errs toward more tokens (see the top of the file). */
  charsPerToken: 2.5,
  /** The tool-use system prompt Anthropic adds when tools are sent (a few hundred), rounded up. */
  toolOverheadTokens: 500,
  /** The message's framing and the tool_use block around the input. */
  outputOverheadTokens: 50,
  /** A model's free-text fields run longer than the scripts' ground truth. */
  outputFactor: 1.5,
  /**
   * Hidden reasoning a call bills as output: none on Haiku 5.5, which skips thinking on a forced
   * tool call; gpt-oss always reasons, about 300 tokens at "low" (spec §4.7), rounded up.
   */
  reasoningTokens: { anthropic: 0, groq: 400 },
  /** The spec's quarter on top of the whole estimate. */
  safetyFactor: 1.25,
} as const;

/** EVAL_SMOKE_BUDGET_USD's ceiling: a run costs cents, so more is a typo ("10" for "0.10"). */
export const SMOKE_MAX_BUDGET_USD = 1;

/** One turn's request and answer, in estimated tokens. */
export interface TurnTokens {
  /** The tool definition and the tool-use prompt: the same on every call of the run. */
  readonly tool: number;
  /** The system prompt: the same on every call of the script. */
  readonly system: number;
  /** The user message: the turn's transcript. */
  readonly transcript: number;
  readonly output: number;
}

const tokens = (chars: number) => Math.ceil(chars / SMOKE_ESTIMATE.charsPerToken);

const TOOL_CHARS =
  SUBMIT_PROPOSALS.length +
  SUBMIT_PROPOSALS_DESCRIPTION.length +
  JSON.stringify(SUBMIT_PROPOSALS_JSON_SCHEMA).length;

const RECAP_TOOL_CHARS =
  SUBMIT_RECAP.length +
  SUBMIT_RECAP_DESCRIPTION.length +
  JSON.stringify(SUBMIT_RECAP_JSON_SCHEMA).length;

/** A script's recap request and expected answer in estimated tokens (Phase 5 WP10). */
export function recapTokens(script: DebriefScript): { input: number; output: number } {
  const prompt = buildRecapPrompt({
    utterances: recapScriptUtterances(script),
    proposals: recapScriptProposals(script),
    lens: recapLens(recapLensOf(script)),
  });
  const lens = groundTruthLens(script);
  const answer = JSON.stringify({
    sentences: groundTruthSentences(script),
    lens: lens ? { fields: lens } : null,
  });
  return {
    input:
      tokens(RECAP_TOOL_CHARS) +
      SMOKE_ESTIMATE.toolOverheadTokens +
      tokens(prompt.instructions.length) +
      tokens(prompt.transcript.length),
    output:
      Math.ceil(tokens(answer.length) * SMOKE_ESTIMATE.outputFactor) +
      SMOKE_ESTIMATE.outputOverheadTokens,
  };
}

/** A turn's request and expected answer in estimated tokens, from what the run will send. */
export function turnTokens(script: DebriefScript, turnIndex: number): TurnTokens {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const prompt = buildPrompt({
    utterances: [understandingUtterances(script, turnIndex).biased],
    callTime: script.callTime,
    timeZone: script.timeZone,
    openAccount: script.focusEntityId ? demoEntity(script.focusEntityId).name : null,
  });
  const answer = JSON.stringify({ proposals: turn.expect.map(toolProposal) });
  return {
    tool: tokens(TOOL_CHARS) + SMOKE_ESTIMATE.toolOverheadTokens,
    system: tokens(prompt.instructions.length),
    transcript: tokens(prompt.transcript.length),
    output:
      Math.ceil(tokens(answer.length) * SMOKE_ESTIMATE.outputFactor) +
      SMOKE_ESTIMATE.outputOverheadTokens,
  };
}

export interface SmokeEstimate {
  readonly scripts: number;
  /** One request each. */
  readonly turns: number;
  /** One recap request per script (Phase 5 WP10). */
  readonly recaps: number;
  /** The recaps' share of `usd`, before the margin. */
  readonly recapUsd: number;
  readonly promptCache: boolean;
  /** Every input token, cache reads and writes included. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** The run at the price table's rates, before the margin. */
  readonly usd: number;
  /** With the margin: what the guard compares with the budget. */
  readonly totalUsd: number;
  /** The same run with no cache hit at all, with the margin. */
  readonly uncachedTotalUsd: number;
  /**
   * One request's average uncached cost, turns and recaps alike, with the margin: what a call that
   * reports no usage is charged.
   */
  readonly perCallUsd: number;
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

function usage(input: {
  uncached: number;
  read: number;
  write: number;
  output: number;
}): TokenUsage {
  return {
    ...ZERO_USAGE,
    inputTokens: input.uncached + input.read + input.write,
    cachedInputTokens: input.read,
    cacheWriteTokens: input.write,
    outputTokens: input.output,
  };
}

/** What a run of these scripts should cost at most, by the price row and the cache plan. */
export function estimateSmokeSpend(
  scripts: readonly DebriefScript[],
  price: LlmPriceRow,
  options: { readonly promptCache: boolean },
): SmokeEstimate {
  const cache = options.promptCache && price.provider === "anthropic";
  let turns = 0;
  let usd = 0;
  let uncachedUsd = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let recapUsd = 0;
  let toolCached = false;
  for (const script of scripts) {
    // The script's recap: never cached, so the same either way.
    const recap = recapTokens(script);
    const recapCall = usage({
      uncached: recap.input,
      read: 0,
      write: 0,
      output: recap.output + SMOKE_ESTIMATE.reasoningTokens[price.provider],
    });
    const recapCost = llmCostUsd(recapCall, price);
    recapUsd += recapCost;
    usd += recapCost;
    uncachedUsd += recapCost;
    inputTokens += recapCall.inputTokens;
    outputTokens += recapCall.outputTokens;
    for (let index = 0; index < script.turns.length; index++) {
      const t = turnTokens(script, index);
      turns++;
      const prefix = t.tool + t.system;
      const output = t.output + SMOKE_ESTIMATE.reasoningTokens[price.provider];
      const plain = usage({ uncached: prefix + t.transcript, read: 0, write: 0, output });
      uncachedUsd += llmCostUsd(plain, price);
      let call = plain;
      if (cache) {
        const read = (toolCached ? t.tool : 0) + (index > 0 ? t.system : 0);
        call = usage({ uncached: t.transcript, read, write: prefix - read, output });
        toolCached = true;
      }
      usd += llmCostUsd(call, price);
      inputTokens += call.inputTokens;
      cachedInputTokens += call.cachedInputTokens;
      cacheWriteTokens += call.cacheWriteTokens;
      outputTokens += call.outputTokens;
    }
  }
  const margin = SMOKE_ESTIMATE.safetyFactor;
  const calls = turns + scripts.length;
  return {
    scripts: scripts.length,
    turns,
    recaps: scripts.length,
    recapUsd: micro(recapUsd),
    promptCache: cache,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    usd: micro(usd),
    totalUsd: micro(usd * margin),
    uncachedTotalUsd: micro(uncachedUsd * margin),
    perCallUsd: calls === 0 ? 0 : micro((uncachedUsd * margin) / calls),
  };
}

/** `EVAL_SMOKE_BUDGET_USD` as dollars: a positive number, at most `SMOKE_MAX_BUDGET_USD`. */
export function parseSmokeBudget(text: string | undefined): number {
  const budget = Number(text);
  if (!text?.trim() || !Number.isFinite(budget) || budget <= 0) {
    throw new Error(
      `EVAL_SMOKE_BUDGET_USD must be a positive number of dollars, not ${JSON.stringify(text ?? "")}`,
    );
  }
  if (budget > SMOKE_MAX_BUDGET_USD) {
    throw new Error(
      `EVAL_SMOKE_BUDGET_USD is ${budget}, above the $${SMOKE_MAX_BUDGET_USD.toFixed(2)} ceiling for one smoke run; a run costs cents (did you mean ${(budget / 100).toFixed(2)}?)`,
    );
  }
  return budget;
}

/** Sums a run's measured spend against its budget. */
export interface BudgetMeter {
  readonly budgetUsd: number;
  readonly spentUsd: number;
  /** Tokens the provider reported, over every call. */
  readonly usage: TokenUsage;
  /** LLM calls made: each attempt, the validation retry's included. */
  readonly calls: number;
  /** Calls that reported no usage and were charged the estimate instead. */
  readonly estimatedCalls: number;
  /** True once the spend has passed the budget. */
  readonly exceeded: boolean;
  /** Adds calls the provider reported usage for, at their measured cost. */
  add(usage: TokenUsage, costUsd: number, calls: number): void;
  /** Adds calls that may be billed but reported nothing (a timeout), at an estimate. */
  charge(usd: number, calls: number): void;
}

/** A meter for one run; `onExceeded` runs once, when the spend first passes the budget. */
export function createBudgetMeter(budgetUsd: number, onExceeded?: () => void): BudgetMeter {
  let spentUsd = 0;
  let total: TokenUsage = ZERO_USAGE;
  let calls = 0;
  let estimatedCalls = 0;
  let exceeded = false;
  const check = () => {
    if (!exceeded && spentUsd > budgetUsd + 1e-12) {
      exceeded = true;
      onExceeded?.();
    }
  };
  return {
    budgetUsd,
    get spentUsd() {
      return roundUsd(spentUsd);
    },
    get usage() {
      return total;
    },
    get calls() {
      return calls;
    },
    get estimatedCalls() {
      return estimatedCalls;
    },
    get exceeded() {
      return exceeded;
    },
    add(usage, costUsd, count) {
      total = {
        inputTokens: total.inputTokens + usage.inputTokens,
        cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
        cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      };
      spentUsd += costUsd;
      calls += count;
      check();
    },
    charge(usd, count) {
      spentUsd += usd;
      calls += count;
      estimatedCalls += count;
      check();
    },
  };
}
