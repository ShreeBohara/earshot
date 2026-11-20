// The live smoke eval's budget guard (Phase 4 WP11 step 2): the estimate's arithmetic from the
// requests a run sends and the price table, the cache plan, the budget's parsing, and the meter
// that stops a run past it.
import {
  buildPrompt,
  findLlmPrice,
  LLM_PRICES,
  type LlmPriceRow,
  llmCostUsd,
  SUBMIT_PROPOSALS,
  SUBMIT_PROPOSALS_DESCRIPTION,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  ZERO_USAGE,
} from "@earshot/agent";
import { describe, expect, it } from "vitest";
import { readSmokeSet } from "../scripts/smoke-io";
import { toolProposal } from "../src/generate";
import { demoEntity } from "../src/session";
import {
  createBudgetMeter,
  estimateSmokeSpend,
  parseSmokeBudget,
  SMOKE_ESTIMATE,
  smokeScripts,
  turnTokens,
} from "../src/smoke";
import { ALL_DEBRIEFS, understandingUtterances } from "../src/understanding";

const HAIKU = findLlmPrice(LLM_PRICES, "anthropic", "claude-haiku-5-5") as LlmPriceRow;
const GPT_OSS = findLlmPrice(LLM_PRICES, "groq", "openai/gpt-oss-20b") as LlmPriceRow;
const SET = smokeScripts(readSmokeSet(), ALL_DEBRIEFS);
const usage = (input: { uncached: number; read?: number; write?: number; output: number }) => ({
  ...ZERO_USAGE,
  inputTokens: input.uncached + (input.read ?? 0) + (input.write ?? 0),
  cachedInputTokens: input.read ?? 0,
  cacheWriteTokens: input.write ?? 0,
  outputTokens: input.output,
});

describe("turnTokens", () => {
  it("counts what the turn's request sends, at 2.5 characters a token, and its answer with a margin", () => {
    const script = SET[0];
    if (!script) throw new Error("no scripts");
    const t = turnTokens(script, 0);
    const toolChars =
      SUBMIT_PROPOSALS.length +
      SUBMIT_PROPOSALS_DESCRIPTION.length +
      JSON.stringify(SUBMIT_PROPOSALS_JSON_SCHEMA).length;
    expect(t.tool).toBe(Math.ceil(toolChars / 2.5) + SMOKE_ESTIMATE.toolOverheadTokens);
    const prompt = buildPrompt({
      utterances: [understandingUtterances(script, 0).biased],
      callTime: script.callTime,
      timeZone: script.timeZone,
      openAccount: script.focusEntityId ? demoEntity(script.focusEntityId).name : null,
    });
    expect(t.system).toBe(Math.ceil(prompt.instructions.length / 2.5));
    expect(t.transcript).toBe(Math.ceil(prompt.transcript.length / 2.5));
    const answer = JSON.stringify({
      proposals: (script.turns[0]?.expect ?? []).map(toolProposal),
    });
    expect(t.output).toBe(
      Math.ceil(Math.ceil(answer.length / 2.5) * 1.5) + SMOKE_ESTIMATE.outputOverheadTokens,
    );
    // The tool schema is most of every request: the case for caching it.
    expect(t.tool).toBeGreaterThan(4 * (t.system + t.transcript));
  });
});

describe("estimateSmokeSpend", () => {
  const two = SET.slice(0, 2);

  it("prices every turn uncached without the cache, then adds a quarter", () => {
    let expected = 0;
    for (const script of two) {
      script.turns.forEach((_, index) => {
        const t = turnTokens(script, index);
        expected += llmCostUsd(
          usage({ uncached: t.tool + t.system + t.transcript, output: t.output }),
          HAIKU,
        );
      });
    }
    const estimate = estimateSmokeSpend(two, HAIKU, { promptCache: false });
    expect(estimate.turns).toBe(two.reduce((n, script) => n + script.turns.length, 0));
    expect(estimate.cachedInputTokens).toBe(0);
    expect(estimate.cacheWriteTokens).toBe(0);
    expect(estimate.usd).toBeCloseTo(expected, 6);
    expect(estimate.totalUsd).toBeCloseTo(expected * 1.25, 6);
    expect(estimate.uncachedTotalUsd).toBe(estimate.totalUsd);
    expect(estimate.perCallUsd).toBeCloseTo((expected * 1.25) / estimate.turns, 6);
  });

  it("follows the cache plan: the run writes the tool once, each script writes its system prompt once, and the rest is read", () => {
    const [a, b] = two;
    if (!a || !b) throw new Error("two scripts");
    let expected = 0;
    let reads = 0;
    let writes = 0;
    [a, b].forEach((script, scriptIndex) => {
      script.turns.forEach((_, index) => {
        const t = turnTokens(script, index);
        const read = (scriptIndex > 0 || index > 0 ? t.tool : 0) + (index > 0 ? t.system : 0);
        const write = t.tool + t.system - read;
        reads += read;
        writes += write;
        expected += llmCostUsd(
          usage({ uncached: t.transcript, read, write, output: t.output }),
          HAIKU,
        );
      });
    });
    const estimate = estimateSmokeSpend(two, HAIKU, { promptCache: true });
    expect(estimate.promptCache).toBe(true);
    expect(estimate.cachedInputTokens).toBe(reads);
    expect(estimate.cacheWriteTokens).toBe(writes);
    expect(estimate.usd).toBeCloseTo(expected, 6);
    expect(estimate.totalUsd).toBeLessThan(estimate.uncachedTotalUsd);
    expect(estimate.uncachedTotalUsd).toBe(
      estimateSmokeSpend(two, HAIKU, { promptCache: false }).totalUsd,
    );
  });

  it("has no cache plan on Groq, and counts gpt-oss's hidden reasoning as output", () => {
    const estimate = estimateSmokeSpend(two, GPT_OSS, { promptCache: true });
    expect(estimate.promptCache).toBe(false);
    expect(estimate.cachedInputTokens).toBe(0);
    const haiku = estimateSmokeSpend(two, HAIKU, { promptCache: false });
    expect(estimate.outputTokens - haiku.outputTokens).toBe(
      SMOKE_ESTIMATE.reasoningTokens.groq * estimate.turns,
    );
  });

  it("puts the smoke set within the default $0.10 with the cache, and over it with no cache hit", () => {
    const cached = estimateSmokeSpend(SET, HAIKU, { promptCache: true });
    expect(cached.turns).toBeGreaterThanOrEqual(110);
    expect(cached.totalUsd).toBeLessThan(0.05);
    // Three runs for a baseline stay near the spec's "about $0.10".
    expect(3 * cached.totalUsd).toBeLessThan(0.15);
    // The v2 tool schema makes an uncached request about 6,500 tokens, not the spec's 2,000.
    const uncached = estimateSmokeSpend(SET, HAIKU, { promptCache: false });
    expect(uncached.totalUsd).toBeGreaterThan(0.1);
    expect(uncached.inputTokens / uncached.turns).toBeGreaterThan(5_000);
  });
});

describe("parseSmokeBudget", () => {
  it("takes a positive number of dollars, up to the $1 ceiling", () => {
    expect(parseSmokeBudget("0.10")).toBe(0.1);
    expect(parseSmokeBudget(" 0.5 ")).toBe(0.5);
    expect(parseSmokeBudget("1")).toBe(1);
    for (const bad of [undefined, "", "  ", "abc", "0", "-0.1", "NaN"]) {
      expect(() => parseSmokeBudget(bad), String(bad)).toThrow(/EVAL_SMOKE_BUDGET_USD/);
    }
    expect(() => parseSmokeBudget("10")).toThrow(/did you mean 0.10/);
  });
});

describe("the budget meter", () => {
  it("sums measured cost and tokens, and trips once, when the spend passes the budget", () => {
    let tripped = 0;
    const meter = createBudgetMeter(0.01, () => tripped++);
    const call = usage({ uncached: 100, read: 6_000, write: 0, output: 200 });
    const cost = llmCostUsd(call, HAIKU);
    meter.add(call, cost, 1);
    expect(meter.spentUsd).toBeCloseTo(cost, 9);
    expect(meter.usage.cachedInputTokens).toBe(6_000);
    expect(meter.calls).toBe(1);
    expect(meter.exceeded).toBe(false);
    meter.add(ZERO_USAGE, 0.01 - cost, 1);
    // At the budget exactly: not past it.
    expect(meter.exceeded).toBe(false);
    meter.add(ZERO_USAGE, 0.000001, 1);
    expect(meter.exceeded).toBe(true);
    meter.add(ZERO_USAGE, 0.5, 1);
    expect(tripped).toBe(1);
    expect(meter.calls).toBe(4);
  });

  it("charges calls that reported nothing at the estimate, and counts them apart", () => {
    const meter = createBudgetMeter(0.001);
    meter.charge(0.0004, 2);
    expect(meter.spentUsd).toBeCloseTo(0.0004, 9);
    expect(meter.estimatedCalls).toBe(2);
    expect(meter.calls).toBe(2);
    meter.charge(0.0007, 1);
    expect(meter.exceeded).toBe(true);
  });
});
