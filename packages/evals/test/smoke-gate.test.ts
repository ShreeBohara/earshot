// The live smoke gate (Phase 4 WP11 step 4) on synthetic metrics: the noise band, the absolute
// gates, an incomplete run, a missing or stale baseline, the baseline's median and spread, and
// when a failure earns its one re-run.
import { describe, expect, it } from "vitest";
import {
  allowedDrop,
  baselineRates,
  LIVE_LABELS,
  SMOKE_BASELINE_FORMAT,
  SmokeBaseline,
  type SmokeIdentity,
  type SmokeSummary,
  shouldRerun,
  smokeGateFailures,
  smokeSummary,
} from "../src/smoke";
import { type UnderstandingMetrics, understandingMetrics } from "../src/understanding";

const IDENTITY: SmokeIdentity = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  linker: "linker.v1",
  scripts: ["d003", "d005"],
  scriptsSha256: "a".repeat(64),
};
const FILE = "packages/evals/baselines/smoke-anthropic.json";

/** Metrics with the gated and absolute numbers set; the rest from an empty run. */
function metrics(values: {
  keyFields?: number;
  targets?: number;
  f1?: number | null;
  evidence?: number;
  wrong?: number;
  decided?: number;
}): UnderstandingMetrics {
  const base = understandingMetrics([], LIVE_LABELS);
  const of = 100;
  const decided = values.decided ?? 100;
  const wrong = values.wrong ?? 0;
  return {
    ...base,
    keyFields: { n: (values.keyFields ?? 0.9) * of, of, rate: values.keyFields ?? 0.9 },
    targets: { n: (values.targets ?? 0.9) * of, of, rate: values.targets ?? 0.9 },
    proposals: { ...base.proposals, f1: values.f1 === undefined ? 0.95 : values.f1 },
    evidence: {
      n: (values.evidence ?? 1) * of,
      of,
      rate: values.evidence ?? 1,
      unquotedLinked: 0,
    },
    wrongAccount: { n: wrong, of: decided, rate: wrong / decided, bound: null },
  };
}

/** A baseline from three runs' gated numbers. */
function baseline(
  runs: { keyFields: number; targets: number; f1: number }[],
  overrides: Partial<SmokeBaseline> = {},
): SmokeBaseline {
  const summaries: SmokeSummary[] = runs.map((run) =>
    smokeSummary(metrics({ keyFields: run.keyFields, targets: run.targets, f1: run.f1 })),
  );
  return SmokeBaseline.parse({
    format: SMOKE_BASELINE_FORMAT,
    ...IDENTITY,
    recordedAt: "2026-11-21",
    source: "local",
    runs: summaries,
    spentUsd: [0.03, 0.03, 0.03],
    ...baselineRates(summaries),
    ...overrides,
  });
}

const STEADY = baseline([
  { keyFields: 0.9, targets: 0.9, f1: 0.95 },
  { keyFields: 0.91, targets: 0.9, f1: 0.95 },
  { keyFields: 0.9, targets: 0.91, f1: 0.95 },
]);
const NOISY = baseline([
  { keyFields: 0.9, targets: 0.84, f1: 0.95 },
  { keyFields: 0.9, targets: 0.9, f1: 0.95 },
  { keyFields: 0.9, targets: 0.92, f1: 0.95 },
]);

const gate = (m: UnderstandingMetrics | null, b: SmokeBaseline | null, complete = true) =>
  smokeGateFailures({
    metrics: m,
    complete,
    stopDetail: complete ? null : "budget",
    baseline: b,
    identity: IDENTITY,
    baselineFile: FILE,
  });
const kinds = (failures: readonly { kind: string }[]) => failures.map((failure) => failure.kind);

describe("the baseline's median and spread", () => {
  it("takes each gated metric's median across the runs, and the largest minus the smallest", () => {
    expect(STEADY.median).toEqual({ keyFieldAccuracy: 0.9, targetAccuracy: 0.9, proposalF1: 0.95 });
    expect(STEADY.spread.keyFieldAccuracy).toBeCloseTo(0.01, 6);
    expect(NOISY.median.targetAccuracy).toBe(0.9);
    expect(NOISY.spread.targetAccuracy).toBeCloseTo(0.08, 6);
    const missing = baselineRates([
      smokeSummary(metrics({ f1: null })),
      smokeSummary(metrics({})),
      smokeSummary(metrics({})),
    ]);
    expect(missing.median.proposalF1).toBeNull();
    expect(missing.spread.proposalF1).toBeNull();
  });

  it("allows max(3 points, 2 × the spread)", () => {
    expect(allowedDrop(0)).toBe(0.03);
    expect(allowedDrop(0.01)).toBe(0.03);
    expect(allowedDrop(0.02)).toBeCloseTo(0.04, 9);
    expect(allowedDrop(null)).toBe(0.03);
  });

  it("refuses a file with other than three runs", () => {
    expect(() => SmokeBaseline.parse({ ...STEADY, runs: STEADY.runs.slice(0, 2) })).toThrow();
  });
});

describe("the gate", () => {
  it("passes a run within the band, evidence complete, wrong accounts at most 2%", () => {
    expect(gate(metrics({ keyFields: 0.875, targets: 0.88, f1: 0.93 }), STEADY)).toEqual([]);
    // Exactly 2% wrong is not above 2%.
    expect(gate(metrics({ wrong: 2, decided: 100 }), STEADY)).toEqual([]);
  });

  it("fails a gated metric more than 3 points down when the baseline runs agreed", () => {
    const failures = gate(metrics({ targets: 0.86 }), STEADY);
    expect(kinds(failures)).toEqual(["regression"]);
    expect(failures[0]?.message).toContain("targetAccuracy 86.0%");
    expect(kinds(gate(metrics({ keyFields: 0.86 }), STEADY))).toEqual(["regression"]);
    expect(kinds(gate(metrics({ f1: 0.91 }), STEADY))).toEqual(["regression"]);
    expect(kinds(gate(metrics({ f1: null }), STEADY))).toEqual(["regression"]);
  });

  it("widens the band to twice the spread when the baseline runs varied", () => {
    // 8 points of spread allow 16 down: 0.76 passes, 0.73 doesn't.
    expect(gate(metrics({ targets: 0.76 }), NOISY)).toEqual([]);
    expect(kinds(gate(metrics({ targets: 0.73 }), NOISY))).toEqual(["regression"]);
  });

  it("fails evidence coverage under 100% and wrong accounts above 2%, whatever the baseline", () => {
    expect(kinds(gate(metrics({ evidence: 0.99 }), STEADY))).toEqual(["evidence"]);
    expect(kinds(gate(metrics({ wrong: 3, decided: 100 }), STEADY))).toEqual(["wrong_account"]);
  });

  it("fails an incomplete run as incomplete, not as a regression", () => {
    const failures = gate(metrics({}), STEADY, false);
    expect(kinds(failures)).toEqual(["incomplete"]);
    expect(failures[0]?.message).toContain("budget");
    expect(kinds(gate(null, STEADY, false))).toEqual(["incomplete"]);
  });

  it("fails with no baseline, still checking the absolute gates, and says how to record one", () => {
    const failures = gate(metrics({ evidence: 0.98 }), null);
    expect(kinds(failures)).toEqual(["evidence", "no_baseline"]);
    expect(failures[1]?.message).toContain("baseline:smoke");
    expect(failures[1]?.message).toContain(FILE);
    expect(kinds(gate(metrics({}), null))).toEqual(["no_baseline"]);
  });

  it("fails a baseline taken on other scripts, files, model, or linker, and skips its comparison", () => {
    for (const stale of [
      { scripts: ["d003"] },
      { scriptsSha256: "b".repeat(64) },
      { model: "claude-haiku-6" },
      { linker: "linker.v2" },
    ]) {
      const failures = gate(metrics({ targets: 0.5 }), { ...STEADY, ...stale });
      expect(kinds(failures), JSON.stringify(stale)).toEqual(["stale_baseline"]);
    }
  });
});

describe("the one re-run", () => {
  const regression = gate(metrics({ targets: 0.8 }), STEADY);
  const wrong = gate(metrics({ wrong: 5 }), STEADY);

  it("comes when a complete run fails only on noisy checks and the budget covers another run", () => {
    expect(
      shouldRerun({ failures: regression, spentUsd: 0.03, budgetUsd: 0.1, estimateUsd: 0.03 }),
    ).toBe(true);
    expect(
      shouldRerun({ failures: wrong, spentUsd: 0.03, budgetUsd: 0.1, estimateUsd: 0.03 }),
    ).toBe(true);
  });

  it("doesn't come for a pass, a lost budget, evidence, an incomplete run, or a missing baseline", () => {
    expect(shouldRerun({ failures: [], spentUsd: 0, budgetUsd: 0.1, estimateUsd: 0.03 })).toBe(
      false,
    );
    expect(
      shouldRerun({ failures: regression, spentUsd: 0.08, budgetUsd: 0.1, estimateUsd: 0.03 }),
    ).toBe(false);
    for (const failures of [
      gate(metrics({ evidence: 0.9, targets: 0.8 }), STEADY),
      gate(metrics({}), STEADY, false),
      gate(metrics({}), null),
    ]) {
      expect(shouldRerun({ failures, spentUsd: 0, budgetUsd: 1, estimateUsd: 0.03 })).toBe(false);
    }
  });
});
