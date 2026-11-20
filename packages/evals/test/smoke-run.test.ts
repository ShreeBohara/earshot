// The live smoke runner (Phase 4 WP11) against scripted providers and the $0 cassettes: it scores
// a model's own drafts the way the understanding eval scores its cassettes, sends every request
// through the pacer, stops past the budget, stops when the provider fails or refuses the key,
// scores invalid output as the model's, and marks the stable prefix for the prompt cache.

import { findLlmPrice, LLM_PRICES, type LlmPriceRow, llmCostUsd, ZERO_USAGE } from "@earshot/agent";
import { createCassetteFetch, SCENARIO_API_KEY } from "@earshot/agent/testing";
import { describe, expect, it } from "vitest";
import { readSmokeSet } from "../scripts/smoke-io";
import { readErrorLabels, readUnderstandingCassettes } from "../scripts/understanding-io";
import {
  createPacer,
  LIVE_LABELS,
  runSmoke,
  type SmokeRunOptions,
  scoredRuns,
  smokeScripts,
  smokeUtterances,
  spreadWords,
} from "../src/smoke";
import {
  ALL_DEBRIEFS,
  runScript,
  summarize,
  understandingDrafts,
  understandingMetrics,
} from "../src/understanding";
import { instantClock, perfectDrafts, scriptedAnthropic } from "./smoke-helpers";

const HAIKU = findLlmPrice(LLM_PRICES, "anthropic", "claude-haiku-5-5") as LlmPriceRow;
const SET = smokeScripts(readSmokeSet(), ALL_DEBRIEFS);
const FEW = SET.slice(0, 3);
const noWait = async () => {};

function options(
  overrides: Partial<SmokeRunOptions> & Pick<SmokeRunOptions, "fetchFor">,
): SmokeRunOptions {
  const clock = instantClock();
  return {
    provider: "anthropic",
    scripts: FEW,
    apiKey: SCENARIO_API_KEY,
    budgetUsd: 0.1,
    perCallUsd: 0.001,
    promptCache: false,
    pacer: createPacer({ now: clock.now, sleep: clock.sleep }),
    sleep: noWait,
    random: () => 0.5,
    ...overrides,
  };
}

describe("smokeUtterances", () => {
  it("times the biased transcript word by word across the turn, and leaves the unbiased one untimed", () => {
    const script = SET[0];
    if (!script) throw new Error("no scripts");
    const { biased, unbiased } = smokeUtterances(script, 1);
    const words = biased.words ?? [];
    expect(words.map((word) => word.w).join(" ")).toBe(biased.text);
    expect(words[0]?.startMs).toBe(biased.startMs);
    expect(words.at(-1)?.endMs).toBeLessThanOrEqual(biased.endMs);
    for (const [index, word] of words.entries()) {
      expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
      if (index > 0) expect(word.startMs).toBeGreaterThanOrEqual(words[index - 1]?.endMs ?? 0);
    }
    expect(unbiased.words).toBeUndefined();
    expect(unbiased.text).toBe(script.turns[1]?.heard.unbiased);
  });

  it("spreads by character count, as the fake speech-to-text adapter does", () => {
    expect(spreadWords("ab cdef", 0, 800, 0.9)).toEqual([
      { w: "ab", startMs: 0, endMs: 200, confidence: 0.9 },
      { w: "cdef", startMs: 300, endMs: 700, confidence: 0.9 },
    ]);
  });
});

describe("runSmoke on the $0 cassettes", () => {
  it("scores the drafts the model returned exactly as the understanding eval scores its cassettes", async () => {
    const labels = readErrorLabels();
    const cassettes = readUnderstandingCassettes().anthropic;
    const run = await runSmoke(
      options({
        fetchFor: (script) =>
          createCassetteFetch(cassettes.cassettes[script.id] as never) as typeof globalThis.fetch,
      }),
    );
    expect(run.complete).toBe(true);
    expect(run.stop).toBeNull();
    for (const script of run.runs) {
      script.turns.forEach((turn, index) => {
        expect(turn.drafts, `${script.script.id} turn ${index + 1}`).toEqual(
          understandingDrafts(script.script, index, labels),
        );
        expect(turn.misses).toBe(0);
      });
    }
    // Word timings on the biased transcript change no decision the $0 eval makes.
    const offline = [];
    for (const script of FEW) {
      offline.push(
        await runScript("anthropic", script, cassettes.cassettes[script.id] as never, labels),
      );
    }
    expect(summarize(understandingMetrics(scoredRuns(run), labels))).toEqual(
      summarize(understandingMetrics(offline, labels)),
    );
  }, 120_000);
});

describe("runSmoke against a scripted model", () => {
  it("sends every request through the pacer, and meters each call at the price table", async () => {
    const model = scriptedAnthropic({ usage: { input: 6_500, output: 250 } });
    const clock = instantClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const run = await runSmoke(options({ fetchFor: model.fetchFor, pacer }));
    const turns = FEW.reduce((n, script) => n + script.turns.length, 0);
    expect(run.complete).toBe(true);
    expect(model.requests).toHaveLength(turns);
    expect(run.requests).toBe(turns);
    expect(pacer.started).toBe(turns);
    expect(run.calls).toBe(turns);
    const perCall = llmCostUsd({ ...ZERO_USAGE, inputTokens: 6_500, outputTokens: 250 }, HAIKU);
    expect(run.spentUsd).toBeCloseTo(perCall * turns, 9);
    expect(run.usage.inputTokens).toBe(6_500 * turns);
    expect(run.outcomes.proposals ?? 0).toBeGreaterThan(0);
    // A perfect model scores perfectly on what the drafts decide.
    const metrics = understandingMetrics(scoredRuns(run), LIVE_LABELS);
    expect(metrics.keyFields.rate).toBe(1);
    expect(metrics.proposals.f1).toBe(1);
    expect(metrics.evidence.rate).toBe(1);
  });

  it("marks the tool and the system prompt for the cache, and prices cache reads at their rate", async () => {
    const model = scriptedAnthropic({ usage: { input: 100, output: 200, cacheRead: 6_000 } });
    const run = await runSmoke(
      options({ fetchFor: model.fetchFor, promptCache: true, scripts: FEW.slice(0, 1) }),
    );
    for (const body of model.requests) {
      const tools = body.tools as { cache_control?: unknown }[];
      const system = body.system as { cache_control?: unknown }[];
      expect(tools[0]?.cache_control).toEqual({ type: "ephemeral" });
      expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    }
    const perCall = llmCostUsd(
      { ...ZERO_USAGE, inputTokens: 6_100, cachedInputTokens: 6_000, outputTokens: 200 },
      HAIKU,
    );
    expect(run.spentUsd).toBeCloseTo(perCall * model.requests.length, 9);
    expect(run.usage.cachedInputTokens).toBe(6_000 * model.requests.length);
  });

  it("stops past the budget, with no request after the one that passed it, and is incomplete", async () => {
    // $0.0101 a call: the third passes a $0.025 budget.
    const model = scriptedAnthropic({ usage: { input: 100_000, output: 200 } });
    const run = await runSmoke(options({ fetchFor: model.fetchFor, budgetUsd: 0.025 }));
    expect(run.complete).toBe(false);
    expect(run.stop).toEqual({ reason: "budget", detail: "budget" });
    expect(model.requests).toHaveLength(3);
    expect(run.spentUsd).toBeGreaterThan(0.025);
    expect(run.runs).toHaveLength(1);
    expect(run.outcomes.cancelled ?? 0).toBeGreaterThan(0);
    // The script it stopped in can't be scored.
    expect(scoredRuns(run)).toHaveLength(0);
  });

  it("stops when the provider keeps failing a turn, past runTurn's retries, and is incomplete", async () => {
    const model = scriptedAnthropic({ status: 529 });
    const run = await runSmoke(options({ fetchFor: model.fetchFor }));
    expect(run.complete).toBe(false);
    expect(run.stop).toEqual({ reason: "provider", detail: "provider_error:http_529" });
    // Three attempts for the first turn, then nothing more.
    expect(model.requests).toHaveLength(3);
    expect(run.failures.provider_error).toBe(1);
  });

  it("stops at once when the provider refuses the key", async () => {
    const model = scriptedAnthropic({ status: 401 });
    const run = await runSmoke(options({ fetchFor: model.fetchFor }));
    expect(run.stop).toEqual({ reason: "provider", detail: "key_rejected:http_401" });
    expect(model.requests).toHaveLength(1);
  });

  it("charges a call that timed out at the estimate, since it may have been billed", async () => {
    const model = scriptedAnthropic({
      throws: () => new DOMException("the request timed out", "TimeoutError"),
    });
    const run = await runSmoke(options({ fetchFor: model.fetchFor, perCallUsd: 0.0005 }));
    expect(run.stop?.reason).toBe("provider");
    expect(run.estimatedCalls).toBe(3);
    expect(run.spentUsd).toBeCloseTo(0.0015, 9);
  });

  it("scores a turn the model answered with invalid output twice as the model's miss, and carries on", async () => {
    const first = FEW[0];
    if (!first) throw new Error("no scripts");
    const model = scriptedAnthropic({
      drafts: (script, index) =>
        script.id === first.id && index === 0
          ? [{ type: "task", target: null, fields: { title: null, dueDate: null } }]
          : perfectDrafts(script, index),
    });
    const run = await runSmoke(options({ fetchFor: model.fetchFor }));
    expect(run.complete).toBe(true);
    expect(run.outcomes.invalid_output).toBe(1);
    expect(run.failures.invalid_output).toBe(1);
    expect(scoredRuns(run)).toHaveLength(FEW.length);
    const metrics = understandingMetrics(scoredRuns(run), LIVE_LABELS);
    expect(metrics.proposals.recall).toBeLessThan(1);
  });

  it("stops when the job is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedAnthropic();
    const run = await runSmoke(options({ fetchFor: model.fetchFor, signal: controller.signal }));
    expect(run.stop).toEqual({ reason: "aborted", detail: "aborted" });
    expect(model.requests).toHaveLength(0);
    expect(run.complete).toBe(false);
  });
});
