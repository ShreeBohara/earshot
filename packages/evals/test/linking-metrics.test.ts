import { describe, expect, it } from "vitest";
import {
  binomialCdf,
  type ConfusableItem,
  clopperPearsonUpper,
  G1,
  gateFailures,
  type LinkDecision,
  type LinkPrediction,
  linkingMarkdown,
  linkingMetrics,
  linkingReport,
  regressionFailures,
  reliability,
  riskCoverage,
  type Scored,
  score,
} from "../src/linking";

describe("the Clopper–Pearson bound", () => {
  it("matches the spec's numbers at 306 decided (Appendix A)", () => {
    expect(clopperPearsonUpper(0, 306)).toBeCloseTo(0.0097, 4);
    expect(clopperPearsonUpper(2, 306)).toBeCloseTo(0.0204, 4); // "2 wrong in 306 gives 2.04%"
    expect(clopperPearsonUpper(4, 306)).toBeCloseTo(0.0297, 4);
    expect(clopperPearsonUpper(6, 306)).toBeCloseTo(0.0383, 4);
  });

  it("has the closed form with no errors, needs 149 or 313 decided for a 2% bound, and rises with k", () => {
    expect(clopperPearsonUpper(0, 50)).toBeCloseTo(1 - 0.05 ** (1 / 50), 9);
    expect(clopperPearsonUpper(0, 149)).toBeLessThanOrEqual(0.02);
    expect(clopperPearsonUpper(0, 148)).toBeGreaterThan(0.02);
    expect(clopperPearsonUpper(2, 313)).toBeLessThanOrEqual(0.02);
    expect(clopperPearsonUpper(2, 312)).toBeGreaterThan(0.02);
    expect(clopperPearsonUpper(5, 5)).toBe(1);
    for (let k = 1; k <= 10; k++) {
      expect(clopperPearsonUpper(k, 306)).toBeGreaterThan(clopperPearsonUpper(k - 1, 306));
    }
    expect(() => clopperPearsonUpper(3, 2)).toThrow(RangeError);
  });

  it("rests on an exact binomial tail", () => {
    expect(binomialCdf(5, 10, 0.5)).toBeCloseTo(638 / 1024, 12);
    expect(binomialCdf(0, 3, 0.2)).toBeCloseTo(0.512, 12);
    expect(binomialCdf(2, 600, 0.9)).toBeGreaterThanOrEqual(0); // no underflow trouble
  });
});

// A hand-made fixture: eight items, a linker with a witness. The expected numbers below are
// worked out by hand in the comments.
const item = (id: string, gold: string, expect: ConfusableItem["expect"]): ConfusableItem => ({
  id,
  split: "test",
  class: expect === "link" ? "A" : expect === "new" ? "E1" : "D",
  type: "note",
  said: { text: "x", kind: "company" },
  biased: { transcript: "x", mention: { start: 0, end: 1, text: "x" }, company: null, noise: [] },
  unbiased: { transcript: "x", mention: { start: 0, end: 1, text: "x" }, company: null, noise: [] },
  context: { focusEntityId: null, company: null, recent: [] },
  gold,
  expect,
  group: null,
  cue: null,
});
const linked = (entityId: string, p: number | null): LinkDecision => ({
  decision: "linked",
  entityId,
  p,
});
const NEW: LinkDecision = { decision: "new", entityId: null, p: null };
const ASK: LinkDecision = { decision: "ask", entityId: null, p: null };
const NONE: LinkDecision = { decision: "none", entityId: null, p: null };
const prediction = (
  id: string,
  biased: LinkDecision,
  final: LinkDecision = biased,
  flagged = false,
): LinkPrediction => ({ id, biased, final, flagged });

const ITEMS = [
  item("i1", "co_001", "link"), // right link
  item("i2", "co_001", "link"), // wrong link, downgraded by the witness
  item("i3", "NEW", "new"), // right "new"
  item("i4", "co_002", "link"), // "new" for a record that exists, unflagged
  item("i5", "NEW", "new"), // a link for a record that doesn't exist, unflagged
  item("i6", "co_004", "ask"), // asked
  item("i7", "co_005", "link"), // right link, flagged but not downgraded
  item("i8", "co_006", "link"), // no target
];
const PREDICTIONS = [
  prediction("i1", linked("co_001", 0.9)),
  prediction("i2", linked("co_046", 0.8), ASK, true),
  prediction("i3", NEW),
  prediction("i4", NEW),
  prediction("i5", linked("co_003", 0.95)),
  prediction("i6", ASK),
  prediction("i7", linked("co_005", 0.6), linked("co_005", 0.6), true),
  prediction("i8", NONE),
];
const ROWS: Scored[] = score(ITEMS, PREDICTIONS);

describe("the metrics, against a hand-worked fixture", () => {
  it("count the final decisions", () => {
    const metrics = linkingMetrics(ROWS, "final", true);
    // Decided: i1, i3, i4, i5, i7. Wrong link: i5. New when existing: i4. Correct: i1, i3, i7.
    expect(metrics).toMatchObject({
      items: 8,
      decided: 5,
      coverage: 5 / 8,
      linked: 3,
      wrongLinks: 1,
      wrongAccountRate: 1 / 5,
      newDecisions: 2,
      newWhenExisting: 1,
      newWhenExistingRate: 1 / 5,
      correct: 3,
      accuracyOnDecided: 3 / 5,
      // i1, i3, i6, i7; i8's "none" isn't the link it should be.
      asExpected: 4,
      // The witness acted on i2 (a downgrade) and i7 (a flag).
      flagged: 2,
      // Decided, wrong, and unflagged: i4 and i5.
      hiddenErrors: 2,
      hiddenErrorRate: 2 / 5,
      // Wrong with the witness off: i2, i4, i5. The witness caught i2.
      divergenceRecall: 1 / 3,
    });
    expect(metrics.bound).toBeCloseTo(clopperPearsonUpper(1, 5), 12);
  });

  it("count the decisions with the witness off", () => {
    const metrics = linkingMetrics(ROWS, "biased", true);
    expect(metrics).toMatchObject({
      decided: 6,
      wrongLinks: 2,
      wrongAccountRate: 2 / 6,
      newWhenExisting: 1,
      correct: 3,
      accuracyOnDecided: 3 / 6,
      flagged: 0,
      hiddenErrors: 3,
      divergenceRecall: null,
    });
  });

  it("admit links by falling p for the risk–coverage curve, with every 'new' in first", () => {
    // Two "new" decisions are always in. Links by p: i5 (0.95, wrong), i1 (0.9), i7 (0.6).
    // Risk after each: 1/3, 1/4, 1/5. AURC is their mean: 47/180.
    const curve = riskCoverage(ROWS, "final", [1, 0.95, 0.9, 0.6, 0]);
    expect(curve.aurc).toBeCloseTo(47 / 180, 12);
    expect(curve.points).toEqual([
      { threshold: 1, coverage: 2 / 8, risk: 0 },
      { threshold: 0.95, coverage: 3 / 8, risk: 1 / 3 },
      { threshold: 0.9, coverage: 4 / 8, risk: 1 / 4 },
      { threshold: 0.6, coverage: 5 / 8, risk: 1 / 5 },
      { threshold: 0, coverage: 5 / 8, risk: 1 / 5 },
    ]);
  });

  it("admit tied links together", () => {
    const rows = score(
      [item("a", "co_001", "link"), item("b", "co_002", "link"), item("c", "co_003", "link")],
      [
        prediction("a", linked("co_001", 0.9)),
        prediction("b", linked("co_009", 0.9)),
        prediction("c", linked("co_003", null)), // no probability counts as 1
      ],
    );
    // c alone: risk 0. Then a and b together: risk 1/3 for both. AURC = (0 + 1/3 + 1/3) / 3.
    expect(riskCoverage(rows, "final").aurc).toBeCloseTo(2 / 9, 12);
  });

  it("admit an ask that only τ_link held back, at its best candidate's p (WP3's finding)", () => {
    const held = (wouldLink: string | null, p: number): LinkDecision => ({
      decision: "ask",
      entityId: null,
      p,
      wouldLink,
    });
    const rows = score(
      [item("a", "co_001", "link"), item("b", "co_002", "link"), item("c", "co_003", "ask")],
      [
        prediction("a", linked("co_001", 0.95)),
        prediction("b", held("co_009", 0.6)), // would link the wrong record at τ_link ≤ 0.6
        prediction("c", held(null, 0.9)), // a near tie: lowering τ_link never links it
      ],
    );
    const curve = riskCoverage(rows, "final", [0.9, 0.6]);
    expect(curve.points).toEqual([
      { threshold: 0.9, coverage: 1 / 3, risk: 0 },
      { threshold: 0.6, coverage: 2 / 3, risk: 1 / 2 },
    ]);
    // a alone: risk 0; then b: 1/2. The asks aren't decided, so the metrics don't count them.
    expect(curve.aurc).toBeCloseTo(1 / 4, 12);
    expect(linkingMetrics(rows, "final", false).decided).toBe(1);
  });

  it("bin links by equal mass for ECE", () => {
    // Links with p: i7 0.6 right, i1 0.9 right, i5 0.95 wrong; one per bin with 3 links in 10 bins.
    const { bins, ece } = reliability(ROWS, "final");
    expect(bins.map((bin) => [bin.count, bin.meanP, bin.accuracy])).toEqual([
      [1, 0.6, 1],
      [1, 0.9, 1],
      [1, 0.95, 0],
    ]);
    expect(ece).toBeCloseTo((0.4 + 0.1 + 0.95) / 3, 12);
    const many = score(
      Array.from({ length: 20 }, (_, i) => item(`m${i}`, "co_001", "link")),
      Array.from({ length: 20 }, (_, i) =>
        prediction(`m${i}`, linked(i % 4 === 0 ? "co_002" : "co_001", 0.75)),
      ),
    );
    // 20 links at p 0.75, 15 right, two per bin: every bin is 50% or 100% right, so each is 0.25
    // from its mean p, and ECE is 0.25, though the links are calibrated overall.
    const result = reliability(many, "final");
    expect(result.bins).toHaveLength(10);
    expect(result.ece).toBeCloseTo(0.25, 12);
  });

  it("are null where they have nothing to divide by", () => {
    const rows = score([item("q", "co_001", "ask")], [prediction("q", ASK)]);
    const metrics = linkingMetrics(rows, "final", false);
    expect(metrics.decided).toBe(0);
    expect(metrics.coverage).toBe(0);
    expect(metrics.wrongAccountRate).toBeNull();
    expect(metrics.bound).toBeNull();
    expect(metrics.aurc).toBeNull();
    expect(metrics.ece).toBeNull();
    expect(metrics.divergenceRecall).toBeNull();
  });

  it("need exactly one prediction per item", () => {
    expect(() => score(ITEMS, PREDICTIONS.slice(1))).toThrow(/no prediction for i1/);
    expect(() => score(ITEMS, [...PREDICTIONS, PREDICTIONS[0] as LinkPrediction])).toThrow(
      /share an id/,
    );
  });
});

describe("the gate and the report", () => {
  const base = linkingMetrics(ROWS, "final", true);

  it("fails G1 on each threshold, and passes inside them", () => {
    expect(gateFailures(base)).toHaveLength(3); // 20% wrong, 62.5% coverage, 20% new-when-existing
    const passing = {
      ...base,
      coverage: G1.minCoverage,
      wrongAccountRate: G1.maxWrongAccountRate,
      newWhenExistingRate: G1.maxNewWhenExistingRate,
    };
    expect(gateFailures(passing)).toEqual([]);
    expect(gateFailures({ ...passing, wrongAccountRate: 0.0201 })[0]).toMatch(/^G1: wrong-account/);
  });

  it("flags regressions past 3 points of coverage or half a point of wrong-account rate", () => {
    expect(regressionFailures(base, base)).toEqual([]);
    expect(regressionFailures({ ...base, coverage: base.coverage - 0.03 }, base)).toEqual([]);
    expect(regressionFailures({ ...base, coverage: base.coverage - 0.031 }, base)).toHaveLength(1);
    const worse = { ...base, wrongAccountRate: (base.wrongAccountRate ?? 0) + 0.006 };
    expect(regressionFailures(worse, base)[0]).toMatch(/^Regression: wrong-account/);
  });

  it("writes a table per class, and says when there's no witness", () => {
    const report = linkingReport(ROWS, {
      linker: "test",
      witness: false,
      set: "fixture",
      split: "test",
    });
    const markdown = linkingMarkdown(report, { gate: null, regressions: null });
    expect(markdown).toContain("| A | CRM name heard exactly | 5 | link |");
    expect(markdown).toContain("n/a (no witness)");
    expect(markdown).toContain("G1 doesn't apply");
    const classes = Object.values(report.perClass);
    expect(classes.reduce((sum, metrics) => sum + metrics.items, 0)).toBe(8);
    expect(classes.reduce((sum, metrics) => sum + metrics.decided, 0)).toBe(report.final.decided);
  });
});
