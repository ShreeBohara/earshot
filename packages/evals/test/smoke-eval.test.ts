// The live smoke eval end to end against a scripted model (Phase 4 WP11): a baseline from three
// runs, a run that passes against it, a model that rewrites the names it quotes (the test PR that
// drops "quote names exactly", in the extreme) failing it after its one re-run, and a report that
// carries numbers only.
import type { ToolProposal } from "@earshot/agent";
import { findLlmPrice, LLM_PRICES, type LlmPriceRow } from "@earshot/agent";
import { SCENARIO_API_KEY } from "@earshot/agent/testing";
import { describe, expect, it } from "vitest";
import { readSmokeSet } from "../scripts/smoke-io";
import { expectedFields } from "../src/schema";
import {
  createPacer,
  estimateSmokeSpend,
  recordSmokeBaseline,
  SmokeBaseline,
  type SmokeIdentity,
  SmokeReport,
  smokeEval,
  smokeMarkdown,
  smokeScripts,
} from "../src/smoke";
import { ALL_DEBRIEFS } from "../src/understanding";
import { instantClock, perfectDrafts, scriptedAnthropic } from "./smoke-helpers";

const HAIKU = findLlmPrice(LLM_PRICES, "anthropic", "claude-haiku-5-5") as LlmPriceRow;
const SCRIPTS = smokeScripts(readSmokeSet(), ALL_DEBRIEFS).slice(0, 6);
const IDENTITY: SmokeIdentity = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  linker: "linker.v1",
  scripts: SCRIPTS.map((script) => script.id),
  scriptsSha256: "c".repeat(64),
};
const FILE = "packages/evals/baselines/smoke-anthropic.json";
const ESTIMATE = estimateSmokeSpend(SCRIPTS, HAIKU, { promptCache: true });
const USAGE = { input: 100, output: 200, cacheRead: 6_000 };

function common() {
  const clock = instantClock();
  return {
    identity: IDENTITY,
    scripts: SCRIPTS,
    apiKey: SCENARIO_API_KEY,
    budgetUsd: 0.1,
    estimate: ESTIMATE,
    promptCache: true,
    pacer: createPacer({ now: clock.now, sleep: clock.sleep }),
    sleep: async () => {},
    random: () => 0.5,
    source: "local",
  };
}

/** A model that ignores "quote names exactly": it rewrites every name it quotes. */
function rewritingDrafts(script: (typeof SCRIPTS)[number], index: number): ToolProposal[] {
  return perfectDrafts(script, index).map((draft) => {
    const out = structuredClone(draft);
    if ("target" in out && out.target !== null) {
      out.target = { ...out.target, quote: `the ${out.target.quote} account` };
    }
    if (out.type === "contact") {
      out.fields.name = { ...out.fields.name, quote: `Mx. ${out.fields.name.quote}` };
    }
    return out;
  });
}

async function recordBaseline(): Promise<SmokeBaseline> {
  const model = scriptedAnthropic({ usage: USAGE });
  const { baseline } = await recordSmokeBaseline({
    ...common(),
    fetchFor: model.fetchFor,
    recordedAt: "2026-11-21",
  });
  return baseline;
}

describe("baseline:smoke's three runs", () => {
  it("make a baseline: each gated metric's median and spread, each run's numbers and spend", async () => {
    const baseline = await recordBaseline();
    expect(SmokeBaseline.parse(baseline)).toEqual(baseline);
    expect(baseline.runs).toHaveLength(3);
    expect(baseline.spentUsd.every((spent) => spent > 0)).toBe(true);
    // A scripted model answers alike each time: no spread.
    expect(baseline.spread).toEqual({ keyFieldAccuracy: 0, targetAccuracy: 0, proposalF1: 0 });
    expect(baseline.median.proposalF1).toBe(1);
    expect(baseline.scripts).toEqual(IDENTITY.scripts);
  }, 120_000);

  it("write nothing when a run doesn't complete", async () => {
    const model = scriptedAnthropic({ status: 529 });
    await expect(
      recordSmokeBaseline({ ...common(), fetchFor: model.fetchFor, recordedAt: "2026-11-21" }),
    ).rejects.toThrow(/incomplete/);
  });
});

describe("smokeEval", () => {
  it("passes a run that matches its baseline, without a re-run", async () => {
    const baseline = await recordBaseline();
    const model = scriptedAnthropic({ usage: USAGE });
    const { report } = await smokeEval({
      ...common(),
      fetchFor: model.fetchFor,
      baseline,
      baselineFile: FILE,
      offline: false,
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(SmokeReport.parse(report)).toEqual(report);
    expect(report.verdict).toBe("pass");
    expect(report.failures).toEqual([]);
    expect(report.attempts).toHaveLength(1);
    expect(smokeMarkdown(report, baseline)).toContain("**Passes.**");
  }, 120_000);

  it("fails a model that rewrites the names it quotes, after one re-run that fails too", async () => {
    const baseline = await recordBaseline();
    const model = scriptedAnthropic({ usage: USAGE, drafts: rewritingDrafts });
    const { report } = await smokeEval({
      ...common(),
      fetchFor: model.fetchFor,
      baseline,
      baselineFile: FILE,
      offline: false,
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(report.verdict).toBe("fail");
    expect(report.attempts).toHaveLength(2);
    expect(report.failures.some((failure) => failure.includes("targetAccuracy"))).toBe(true);
    // The pipeline refused to link the rewritten words, so evidence stays honest.
    expect(report.attempts[1]?.summary?.evidenceCoverage).toBe(1);
    expect(smokeMarkdown(report, baseline)).toContain("re-run");
  }, 120_000);

  it("skips the re-run when the budget can't cover it", async () => {
    const baseline = await recordBaseline();
    const model = scriptedAnthropic({ usage: USAGE, drafts: rewritingDrafts });
    const { report } = await smokeEval({
      ...common(),
      budgetUsd: ESTIMATE.totalUsd * 1.2,
      fetchFor: model.fetchFor,
      baseline,
      baselineFile: FILE,
      offline: false,
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(report.verdict).toBe("fail");
    expect(report.attempts).toHaveLength(1);
  }, 120_000);

  it("fails with no baseline, and says how to record one", async () => {
    const model = scriptedAnthropic({ usage: USAGE });
    const { report } = await smokeEval({
      ...common(),
      fetchFor: model.fetchFor,
      baseline: null,
      baselineFile: FILE,
      offline: false,
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(report.verdict).toBe("fail");
    expect(report.attempts).toHaveLength(1);
    expect(report.failures).toEqual([expect.stringContaining("baseline:smoke")]);
    // The absolute gates still ran, and passed.
    expect(report.attempts[0]?.summary?.evidenceCoverage).toBe(1);
  }, 120_000);

  it("never puts a transcript, a quote, or anything the model wrote in the report or the summary", async () => {
    const baseline = await recordBaseline();
    const model = scriptedAnthropic({ usage: USAGE, drafts: rewritingDrafts });
    const { report } = await smokeEval({
      ...common(),
      fetchFor: model.fetchFor,
      baseline,
      baselineFile: FILE,
      offline: false,
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    const published = `${JSON.stringify(report)}\n${smokeMarkdown(report, baseline)}`;
    expect(published).not.toContain(SCENARIO_API_KEY);
    for (const script of SCRIPTS) {
      for (const turn of script.turns) {
        expect(published).not.toContain(turn.heard.biased);
        expect(published).not.toContain(turn.heard.unbiased);
        for (const proposal of turn.expect) {
          for (const [, field] of expectedFields(proposal)) {
            // Short quotes ("Friday") could appear by chance in fixed words; long ones can't.
            if (field.quote.length >= 12) expect(published).not.toContain(field.quote);
          }
        }
      }
    }
    expect(published).not.toContain(' account"'); // a rewritten quote
  }, 120_000);
});
