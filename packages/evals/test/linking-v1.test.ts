// Linker v1 (spec WP4) on the confusable-name set: its committed parameters are a fresh,
// deterministic fit on the calibration split alone; it scores as its committed baseline; it meets
// the spec's timing target on the demo CRM's 250 records; and its probabilities and asks carry
// what the harness needs. The unit tests are in @earshot/understanding (test/link.test.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  EntityKind as CoreEntityKind,
  TargetBasis as CoreTargetBasis,
  TargetCandidate as CoreTargetCandidate,
  TargetDecision as CoreTargetDecision,
} from "@earshot/core";
import {
  buildLinkIndex,
  type EntityKind,
  LINKER_PARAMS_V1,
  link,
  type TargetBasis,
  type TargetCandidate,
  type TargetDecision,
} from "@earshot/understanding/link";
import { HOMOPHONES as PRODUCT_HOMOPHONES } from "@earshot/understanding/names";
import { describe, expect, it } from "vitest";
import { HOMOPHONES } from "../src/channel";
import {
  ABLATIONS,
  ablationTable,
  asExpected,
  CONFUSABLE_SET_FILE,
  fitLinker,
  isDecided,
  isWrongLink,
  LINKER_V1,
  LINKING_ENTITIES,
  LinkingBaseline,
  type LinkingCase,
  linkerInput,
  linkerV1,
  linkingCase,
  linkingReport,
  parseConfusableSet,
  type Sees,
  score,
  splitSummary,
  WITNESS_ONLY_CLASSES,
} from "../src/linking";

const TEXT = readFileSync(new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url), "utf8");
const ITEMS = parseConfusableSet(TEXT);
const BASELINE = LinkingBaseline.parse(
  JSON.parse(readFileSync(new URL("../baselines/linking-v1.json", import.meta.url), "utf8")),
);
const SCORED = score(ITEMS, LINKER_V1.predict(ITEMS.map(linkingCase), LINKING_ENTITIES));
const FITTED = fitLinker(ITEMS, LINKING_ENTITIES);

// @earshot/understanding restates four contract types instead of importing @earshot/core (whose
// session tickets need Web Crypto types a DOM-free program lacks). This fails to compile if the
// two drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const CONTRACTS_AGREE: [
  Same<EntityKind, CoreEntityKind>,
  Same<TargetDecision, CoreTargetDecision>,
  Same<TargetBasis, CoreTargetBasis>,
  Same<TargetCandidate, CoreTargetCandidate>,
] = [true, true, true, true];

describe("linker v1's parameters", () => {
  it("restate the contracts' types exactly", () => {
    expect(CONTRACTS_AGREE).toEqual([true, true, true, true]);
  });

  it("are a fresh fit on confusable.v1's calibration split (params.v1.json)", () => {
    const fitted = FITTED;
    expect(fitted.params.features).toEqual(LINKER_PARAMS_V1.features);
    expect(fitted.params.sources).toEqual(LINKER_PARAMS_V1.sources);
    expect(fitted.params.thresholds).toEqual(LINKER_PARAMS_V1.thresholds);
    expect(fitted.params.bias).toBeCloseTo(LINKER_PARAMS_V1.bias, 9);
    for (const feature of fitted.params.features) {
      expect(fitted.params.weights[feature], feature).toBeCloseTo(
        LINKER_PARAMS_V1.weights[feature] ?? Number.NaN,
        9,
      );
    }
    const calibration = TEXT.split("\n").filter(
      (line) => line.trim() !== "" && JSON.parse(line).split === "calibration",
    );
    const sha256 = createHash("sha256")
      .update(calibration.map((line) => `${line}\n`).join(""))
      .digest("hex");
    expect(LINKER_PARAMS_V1.provenance?.calibration.sha256).toBe(sha256);
    expect(fitted.candidateRecall.found).toBe(fitted.candidateRecall.of);
  });

  it("come out the same every time, and never read the test split", () => {
    const calibrationOnly = ITEMS.filter((item) => item.split === "calibration");
    expect(fitLinker(ITEMS, LINKING_ENTITIES)).toEqual(FITTED);
    expect(fitLinker(calibrationOnly, LINKING_ENTITIES)).toEqual(FITTED);
  });
});

describe("linker v1 on confusable.v1", () => {
  it("scores today exactly as its committed baseline says (baselines/linking-v1.json)", () => {
    expect(BASELINE.setSha256).toBe(createHash("sha256").update(TEXT).digest("hex"));
    expect(BASELINE.linker).toBe("linker.v1");
    for (const split of ["calibration", "test"] as const) {
      const report = linkingReport(
        SCORED.filter((row) => row.item.split === split),
        { linker: LINKER_V1.name, witness: false, set: BASELINE.set, split },
      );
      expect(splitSummary(report), split).toEqual(BASELINE.splits[split]);
    }
  });

  it("decides with the biased witness alone until WP5 adds the second", () => {
    expect(LINKER_V1.witness).toBe(false);
    expect(LINKER_V1.gate).toBe(true);
    for (const { prediction } of SCORED) {
      expect(prediction.final).toEqual(prediction.biased);
      expect(prediction.flagged).toBe(false);
    }
  });

  it("keeps its own wrong links under the fit's 1.5% on both splits", () => {
    for (const split of ["calibration", "test"] as const) {
      const rows = SCORED.filter((row) => row.item.split === split);
      const decided = rows.filter((row) => isDecided(row.prediction.biased)).length;
      const own = rows.filter(
        (row) =>
          !WITNESS_ONLY_CLASSES.includes(row.item.class) &&
          isWrongLink(row.prediction.biased, row.item.gold),
      ).length;
      expect(own / decided, split).toBeLessThanOrEqual(0.015);
    }
  });

  it("gets the Sean, Shawn, and Shaun Murphy items right, which need the homophone list", () => {
    const murphys = SCORED.filter((row) => row.item.group === "cg_22");
    expect(murphys.length).toBeGreaterThanOrEqual(9);
    for (const row of murphys) {
      expect(asExpected(row.prediction.biased, row.item), row.item.id).toBe(true);
    }
  });

  it("gives probabilities in [0, 1], and an ask its best candidate's p", () => {
    const index = buildLinkIndex(LINKING_ENTITIES);
    let asks = 0;
    for (const item of ITEMS) {
      for (const witness of ["biased", "unbiased"] as const) {
        const input = linkerInput(linkingCase(item), witness);
        const result = link(input.mention, { ...input, index, params: LINKER_PARAMS_V1 });
        for (const p of [result.p, ...result.candidates.map((candidate) => candidate.p)]) {
          if (p === null) continue;
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
        if (result.decision === "ask") {
          asks++;
          const best = result.candidates.find((candidate) => candidate.entityId !== null);
          expect(result.p).toBe(best?.p);
        }
      }
    }
    expect(asks).toBeGreaterThan(0);
  });

  it("holds back a link from an ask only when the margin over the next candidate clears δ", () => {
    const { delta } = LINKER_PARAMS_V1.thresholds;
    const index = buildLinkIndex(LINKING_ENTITIES);
    for (const row of SCORED) {
      const decision = row.prediction.biased;
      if (decision.decision !== "ask") {
        expect(decision.wouldLink ?? null).toBeNull();
        continue;
      }
      const input = linkerInput(linkingCase(row.item));
      const result = link(input.mention, { ...input, index, params: LINKER_PARAMS_V1 });
      const [first, second] = result.candidates.filter((candidate) => candidate.entityId !== null);
      const leads = first !== undefined && first.p - (second?.p ?? 0) >= delta;
      expect(decision.wouldLink ?? null).toBe(leads ? (first?.entityId ?? null) : null);
    }
  });

  it("links 1,000 mentions against the demo CRM's 250 records in under a second (target)", () => {
    expect(LINKING_ENTITIES).toHaveLength(250);
    const inputs = ITEMS.flatMap((item) =>
      (["biased", "unbiased"] as const).map((witness) => linkerInput(linkingCase(item), witness)),
    ).slice(0, 1000);
    expect(inputs).toHaveLength(1000);
    // CPU time, not wall time: it's what the work costs, and it doesn't count the time a busy
    // machine (turbo runs every package at once) spends on other processes. About 0.2 s alone.
    const started = process.cpuUsage();
    const wall = performance.now();
    const index = buildLinkIndex(LINKING_ENTITIES);
    for (const input of inputs) link(input.mention, { ...input, index, params: LINKER_PARAMS_V1 });
    const used = process.cpuUsage(started);
    const cpuMs = (used.user + used.system) / 1000;
    expect(
      cpuMs,
      `${cpuMs.toFixed(0)} ms of CPU, ${(performance.now() - wall).toFixed(0)} ms of wall time`,
    ).toBeLessThan(1000);
  });
});

describe("the ablations", () => {
  it("lose most of the coverage without sound, and much of it without context", () => {
    const rows = ablationTable(ITEMS, LINKING_ENTITIES, (item) => item.split === "test");
    const coverage = Object.fromEntries(rows.map((row) => [row.name, row.metrics.coverage]));
    expect(rows.map((row) => row.name)).toEqual([
      "v1",
      "no-sound",
      "no-trigrams",
      "no-context",
      "no-focus",
    ]);
    expect(coverage.v1).toBeGreaterThan((coverage["no-sound"] ?? 1) + 0.3);
    expect(coverage.v1).toBeGreaterThan((coverage["no-context"] ?? 1) + 0.2);
  });

  it("hide what they remove from the input, so nothing derived from it still sees it", () => {
    // Codex's catch on #42: without this, "no-focus" still read the open account through the
    // prefilter's bonus and through `rivalContext`. Blanking the hidden context in the cases
    // themselves must change no prediction.
    const blank =
      (sees: Sees) =>
      (linkingCase: LinkingCase): LinkingCase => ({
        ...linkingCase,
        focusEntityId: sees.focus ? linkingCase.focusEntityId : null,
        recent: sees.recent ? linkingCase.recent : [],
        biased: sees.company ? linkingCase.biased : { ...linkingCase.biased, company: null },
      });
    const cases = ITEMS.filter((item) => item.split === "test").map(linkingCase);
    for (const name of ["no-focus", "no-context"]) {
      const ablation = ABLATIONS.find((candidate) => candidate.name === name);
      if (!ablation) throw new Error(`no ablation ${name}`);
      const { params } = fitLinker(ITEMS, LINKING_ENTITIES, ablation.config);
      const linker = linkerV1(params, { name, baseline: null, sees: ablation.config.sees });
      const blanked = cases.map(blank(ablation.config.sees));
      expect(cases.some((linkingCase, k) => linkingCase !== blanked[k])).toBe(true);
      expect(linker.predict(blanked, LINKING_ENTITIES), name).toEqual(
        linker.predict(cases, LINKING_ENTITIES),
      );
    }
  });

  it("share one homophone list with the product", () => {
    expect(HOMOPHONES).toBe(PRODUCT_HOMOPHONES);
  });
});
