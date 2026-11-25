// The recap's live check (Phase 5 WP10; ADR-0037), at $0 and with no network: the plan prices the
// worst case under the spec's $0.01 and refuses, before it reads any key, a budget over the cap or
// under the estimate, then needs the flag and every chosen provider's key; the run is production's
// recap, driven here by the recap cassettes, stops before a provider that would pass the budget,
// and reports numbers and fixed codes only, never a key or a word of the debrief.

import { createCassetteFetch } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { readRecapCassettes } from "../scripts/recap-io";
import {
  estimateRecapLive,
  groundTruthSentences,
  planRecapLive,
  RECAP_LIVE_FLAG,
  RECAP_LIVE_KEYS,
  RECAP_LIVE_MAX_USD,
  RECAP_LIVE_SCRIPT,
  type RecapLivePlan,
  recapLiveMarkdown,
  recapLivePassed,
  recapScriptUtterances,
  runRecapLive,
} from "../src/recap";
import { anyDebrief } from "../src/understanding";

const script = anyDebrief(RECAP_LIVE_SCRIPT);
const PROVIDERS: LlmProvider[] = ["anthropic", "groq"];
// Key-shaped canaries, built at run time: neither may show up in anything the check reports.
const CANARY: Record<LlmProvider, string> = {
  anthropic: `sk-ant-api03-${"q".repeat(40)}`,
  groq: `gsk_${"Q".repeat(40)}`,
};
const LIVE_ENV = {
  [RECAP_LIVE_FLAG]: "1",
  [RECAP_LIVE_KEYS.anthropic]: CANARY.anthropic,
  [RECAP_LIVE_KEYS.groq]: CANARY.groq,
};

/** An environment that records every variable read from it. */
function watchedEnv(values: Record<string, string>) {
  const read: string[] = [];
  const env = new Proxy(values, {
    get(target, name) {
      if (typeof name === "string") read.push(name);
      return typeof name === "string" ? target[name] : undefined;
    },
  }) as Readonly<Record<string, string | undefined>>;
  return { env, read };
}

const okPlan = (plan: RecapLivePlan) => {
  if (!plan.ok) throw new Error(`expected the plan to pass: ${plan.refusal}`);
  return plan;
};

const cassetteFetch = (provider: LlmProvider) => {
  const cassette = readRecapCassettes()[provider].cassettes[script.id];
  if (!cassette) throw new Error(`no recap cassette for ${script.id}`);
  return createCassetteFetch(cassette) as unknown as typeof globalThis.fetch;
};

describe("the recap's live check: the plan", () => {
  it("prices both providers' worst case on its debrief under the spec's $0.01", () => {
    const estimates = PROVIDERS.map((provider) => estimateRecapLive(provider, script));
    for (const estimate of estimates) expect(estimate.usd).toBeGreaterThan(0);
    const total = estimates.reduce((sum, estimate) => sum + estimate.usd, 0);
    expect(total).toBeLessThan(RECAP_LIVE_MAX_USD);
    expect(script.id).toBe("d002");
  });

  it("refuses a budget over the cap, or under the estimate, before it reads the flag or a key", () => {
    for (const budgetUsd of [0.02, 0, Number.NaN, 0.000001]) {
      const { env, read } = watchedEnv(LIVE_ENV);
      const plan = planRecapLive({ providers: PROVIDERS, script, budgetUsd, env });
      expect(plan.ok).toBe(false);
      expect(read).toEqual([]);
    }
  });

  it("is off without the flag, naming what it needs, and reads no key", () => {
    const { env, read } = watchedEnv({
      [RECAP_LIVE_KEYS.anthropic]: CANARY.anthropic,
      [RECAP_LIVE_KEYS.groq]: CANARY.groq,
    });
    const plan = planRecapLive({ providers: PROVIDERS, script, budgetUsd: 0.01, env });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toContain(`${RECAP_LIVE_FLAG}=1`);
    expect(plan.refusal).toContain("EVAL_ANTHROPIC_KEY");
    expect(plan.refusal).toContain("EVAL_GROQ_KEY");
    expect(read).toEqual([RECAP_LIVE_FLAG]);
  });

  it("needs every chosen provider's key, and never repeats the one it has", () => {
    const plan = planRecapLive({
      providers: PROVIDERS,
      script,
      budgetUsd: 0.01,
      env: { [RECAP_LIVE_FLAG]: "1", [RECAP_LIVE_KEYS.anthropic]: CANARY.anthropic },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe("EVAL_GROQ_KEY isn't set.");
    // One provider needs only its own key.
    const anthropic = planRecapLive({
      providers: ["anthropic"],
      script,
      budgetUsd: 0.01,
      env: { [RECAP_LIVE_FLAG]: "1", [RECAP_LIVE_KEYS.anthropic]: CANARY.anthropic },
    });
    expect(anthropic.ok).toBe(true);
  });

  it("refuses with no provider chosen", () => {
    const plan = planRecapLive({ providers: [], script, budgetUsd: 0.01, env: LIVE_ENV });
    expect(plan.ok).toBe(false);
  });
});

describe("the recap's live check: the run, on cassettes", () => {
  it("writes each provider's recap through production's path and reports numbers only", async () => {
    const plan = okPlan(
      planRecapLive({ providers: PROVIDERS, script, budgetUsd: 0.01, env: LIVE_ENV }),
    );
    const report = await runRecapLive(plan, { fetchFor: cassetteFetch });
    expect(report.passed).toBe(true);
    expect(report.stopped).toBeNull();
    expect(report.results.map((result) => result.provider)).toEqual(PROVIDERS);
    for (const result of report.results) {
      expect(result).toMatchObject({
        outcome: "created",
        reason: null,
        failure: null,
        headline: true,
        withinDeadline: true,
        lens: "meddic",
        lensFields: 6,
      });
      expect(result.kept).toBeGreaterThan(0);
      expect(result.withEvidence).toBe(result.kept);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(recapLivePassed(result)).toBe(true);
    }
    expect(report.spentUsd).toBeLessThan(report.estimateUsd);

    const shown = `${JSON.stringify(report)}\n${recapLiveMarkdown(report)}`;
    for (const key of Object.values(CANARY)) {
      expect(shown).not.toContain(key);
      expect(shown).not.toContain(key.slice(-12));
    }
    for (const sentence of groundTruthSentences(script)) expect(shown).not.toContain(sentence.text);
    for (const utterance of recapScriptUtterances(script)) {
      expect(shown).not.toContain(utterance.text.slice(0, 24));
    }
    expect(recapLiveMarkdown(report)).toContain("meddic: ");
  }, 30_000);

  it("stops before a provider whose estimate would pass what's left of the budget", async () => {
    const plan = okPlan(
      planRecapLive({ providers: PROVIDERS, script, budgetUsd: 0.01, env: LIVE_ENV }),
    );
    const [cheaper, pricier] = [...plan.estimates].sort((a, b) => a.usd - b.usd);
    if (!cheaper || !pricier) throw new Error("two estimates expected");
    const report = await runRecapLive(
      { ...plan, estimates: [cheaper, pricier], budgetUsd: cheaper.usd },
      { fetchFor: cassetteFetch },
    );
    expect(report.results.map((result) => result.provider)).toEqual([cheaper.provider]);
    expect(report.stopped).toContain(`${pricier.provider} wasn't run`);
    expect(report.passed).toBe(false);
  }, 30_000);

  it("fails on a recap that didn't come back, with fixed codes and none of the provider's words", async () => {
    const plan = okPlan(
      planRecapLive({ providers: ["anthropic"], script, budgetUsd: 0.01, env: LIVE_ENV }),
    );
    const rejected = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key, look here" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const report = await runRecapLive(plan, { fetchFor: () => rejected });
    expect(report.passed).toBe(false);
    const [result] = report.results;
    expect(result).toMatchObject({ outcome: "failed", reason: "provider_error", kept: 0 });
    expect(result?.failure).toMatch(/^key_rejected:/);
    expect(recapLiveMarkdown(report)).not.toContain("look here");
  }, 30_000);
});
