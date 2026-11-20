import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alikeTo,
  CALIBRATION_SHARE,
  CLASS_COUNTS,
  CLASS_SHARES,
  CONFUSABLE_SET_FILE,
  type ConfusableItem,
  DECOYS,
  G1,
  gateFailures,
  generateConfusableSet,
  hasLinkingEntity,
  ITEM_CLASSES,
  inDemoCrm,
  LINKER_ORACLE,
  LINKING_ENTITIES,
  LOOKALIKE_FREE_COMPANIES,
  linkingCase,
  linkingReport,
  type Observation,
  parseConfusableSet,
  resolve,
  SET_SIZE,
  score,
  serializeConfusableSet,
  soundMatches,
  TYPE_KINDS,
} from "../src/linking";

const FILE = new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url);
const TEXT = readFileSync(FILE, "utf8");
const ITEMS = parseConfusableSet(TEXT);

function observe(item: ConfusableItem, witness: "biased" | "unbiased"): Observation {
  return {
    type: item.type,
    kind: item.said.kind,
    mention: item[witness].mention.text,
    company: item[witness].company?.text ?? null,
    focusEntityId: item.context.focusEntityId,
    recent: item.context.recent,
  };
}

describe("the committed confusable set", () => {
  it("is exactly what the generator writes (v1 is frozen: a change is confusable.v2, never an edit)", () => {
    expect(serializeConfusableSet(generateConfusableSet())).toBe(TEXT);
  });

  it("has the spec's 600 items, ids in order, and each class's share within a point", () => {
    expect(ITEMS).toHaveLength(SET_SIZE);
    expect(ITEMS.map((item) => item.id)).toEqual(
      ITEMS.map((_, index) => `cf-${String(index + 1).padStart(4, "0")}`),
    );
    for (const itemClass of ITEM_CLASSES) {
      const count = ITEMS.filter((item) => item.class === itemClass).length;
      expect(count, itemClass).toBe(CLASS_COUNTS[itemClass]);
      expect(Math.abs(count / SET_SIZE - CLASS_SHARES[itemClass]), itemClass).toBeLessThanOrEqual(
        0.01,
      );
    }
  });

  it("splits 40/60 into calibration and test, by class and by confusable group", () => {
    const calibration = ITEMS.filter((item) => item.split === "calibration");
    expect(calibration).toHaveLength(240);
    for (const itemClass of ITEM_CLASSES) {
      const ofClass = ITEMS.filter((item) => item.class === itemClass);
      const inCalibration = ofClass.filter((item) => item.split === "calibration").length;
      expect(Math.abs(inCalibration - CALIBRATION_SHARE * ofClass.length), itemClass).toBeLessThan(
        1,
      );
      const groups = new Set(ofClass.map((item) => item.group));
      for (const group of groups) {
        const stratum = ofClass.filter((item) => item.group === group);
        const share = stratum.filter((item) => item.split === "calibration").length;
        expect(
          Math.abs(share - CALIBRATION_SHARE * stratum.length),
          `${itemClass} ${group}`,
        ).toBeLessThan(1.5);
      }
    }
  });

  it("names only demo CRM records: every gold id, open account, earlier link, and company", () => {
    const known = (id: string) => id === "NEW" || hasLinkingEntity(id);
    for (const item of ITEMS) {
      expect(known(item.gold), item.id).toBe(true);
      if (item.context.focusEntityId !== null) {
        expect(hasLinkingEntity(item.context.focusEntityId), item.id).toBe(true);
      }
      for (const id of item.context.recent) expect(hasLinkingEntity(id), item.id).toBe(true);
      if (item.context.company) expect(known(item.context.company.gold), item.id).toBe(true);
      expect(TYPE_KINDS[item.type], item.id).toContain(item.said.kind);
    }
  });

  it("puts every span inside its transcript, in both readings", () => {
    for (const item of ITEMS) {
      for (const witness of ["biased", "unbiased"] as const) {
        const reading = item[witness];
        for (const span of [reading.mention, reading.company]) {
          if (span === null) continue;
          expect(reading.transcript.slice(span.start, span.end), `${item.id} ${witness}`).toBe(
            span.text,
          );
          expect(reading.transcript.includes(span.text)).toBe(true);
        }
      }
    }
  });

  it("includes all 18 companies with no look-alike in class A", () => {
    expect(LOOKALIKE_FREE_COMPANIES).toHaveLength(18);
    const inA = new Set(ITEMS.filter((item) => item.class === "A").map((item) => item.gold));
    for (const id of LOOKALIKE_FREE_COMPANIES) expect(inA.has(id), id).toBe(true);
  });

  it("labels each item with the decision its ground truth gives", () => {
    for (const item of ITEMS) {
      const biased = resolve(observe(item, "biased"));
      const unbiased = resolve(observe(item, "unbiased"));
      switch (item.class) {
        case "A":
        case "B":
          expect(biased.matches, item.id).toEqual([item.gold]);
          expect(biased.entityId, item.id).toBe(item.gold);
          break;
        case "C":
          expect(biased.decision, item.id).toBe("link");
          expect(biased.entityId, item.id).toBe(item.gold);
          if (item.cue === "tail") {
            // The deal's company words name two deals or more; its tail (lowercase) names one.
            const words = item.biased.mention.text.split(" ");
            const tailAt = words.findIndex((word) => /^\p{Ll}/u.test(word));
            const companyWords = words.slice(0, tailAt).join(" ");
            expect(tailAt, item.id).toBeGreaterThan(0);
            expect(soundMatches(companyWords, "deal").length, item.id).toBeGreaterThanOrEqual(2);
            expect(biased.matches, item.id).toEqual([item.gold]);
          } else {
            expect(biased.matches.length, item.id).toBeGreaterThanOrEqual(2);
            expect(biased.cues, item.id).toEqual([item.cue]);
          }
          break;
        case "D":
          expect(biased.decision, item.id).toBe("ask");
          expect(biased.matches, item.id).toContain(item.gold);
          break;
        case "E1":
        case "F":
          expect(biased.decision, item.id).toBe("new");
          break;
        case "E2":
          // Biased only, it would link a record that isn't there; the second witness heard the new name.
          expect(biased.decision, item.id).toBe("link");
          expect(unbiased.decision, item.id).toBe("new");
          expect(item.biased.noise, item.id).toContain("snap");
          break;
        case "G":
          expect(biased.decision, item.id).toBe("link");
          expect(biased.entityId, item.id).toBe(item.context.focusEntityId);
          expect(biased.entityId, item.id).not.toBe(item.gold);
          expect(unbiased.entityId, item.id).toBe(item.gold);
          break;
      }
    }
  });

  it("leaves G1 reachable: its ground truth, run as a two-witness linker, passes on both splits", () => {
    const scored = score(ITEMS, LINKER_ORACLE.predict(ITEMS.map(linkingCase), LINKING_ENTITIES));
    for (const split of ["calibration", "test"] as const) {
      const report = linkingReport(
        scored.filter((row) => row.item.split === split),
        { linker: LINKER_ORACLE.name, witness: true, set: "confusable.v1", split },
      );
      expect(gateFailures(report.final), split).toEqual([]);
      // The headroom: the spec aims for about 90% decided by a perfect linker; false conflicts
      // from the unbiased witness's sound changes take a few points of it.
      expect(report.final.coverage, split).toBeGreaterThan(G1.minCoverage + 0.02);
      expect(report.final.wrongLinks, split).toBe(0);
      // With the witness off, the snapped new names (E2) and the wrong open accounts (G) are
      // wrong links nobody sees; the witness catches every one.
      expect(report.biasedOnly.wrongLinks, split).toBe(
        report.perClass.E2.items + report.perClass.G.items,
      );
      expect(report.final.divergenceRecall, split).toBe(1);
    }
  });

  it("only ever snaps in the biased reading", () => {
    for (const item of ITEMS) {
      expect(
        item.unbiased.noise.some((op) => op.includes("snap")),
        item.id,
      ).toBe(false);
    }
  });

  it("shows a linker no labels", () => {
    const linkingView = linkingCase(ITEMS[0] as ConfusableItem);
    expect(Object.keys(linkingView).sort()).toEqual(
      ["biased", "focusEntityId", "id", "kind", "recent", "type", "unbiased"].sort(),
    );
    expect(Object.keys(linkingView.biased).sort()).toEqual(["company", "mention", "transcript"]);
  });

  it("refuses a line whose span doesn't match its transcript", () => {
    const item = structuredClone(ITEMS[0] as ConfusableItem);
    item.biased.mention.start += 1;
    expect(() => parseConfusableSet(JSON.stringify(item))).toThrow(
      /line 1 \(cf-0001\): biased mention span/,
    );
  });
});

describe("the decoys", () => {
  it("are 80, about two-thirds sound-alikes", () => {
    expect(DECOYS).toHaveLength(80);
    const alike = DECOYS.filter((decoy) => decoy.like !== null).length;
    expect(alike / DECOYS.length).toBeGreaterThan(0.6);
    expect(alike / DECOYS.length).toBeLessThan(0.72);
    expect(new Set(DECOYS.map((decoy) => decoy.text)).size).toBe(DECOYS.length);
  });

  it("are absent from the demo CRM, and never sound the same as a record", () => {
    for (const decoy of DECOYS) {
      expect(inDemoCrm(decoy.text, decoy.kind), decoy.text).toBe(false);
      expect(soundMatches(decoy.text, decoy.kind), decoy.text).toEqual([]);
    }
  });

  it("sound like the record they name, or like nothing", () => {
    for (const decoy of DECOYS) {
      const alike = alikeTo(decoy.text, decoy.kind);
      if (decoy.like === null) expect(alike, decoy.text).toEqual([]);
      else expect(alike, decoy.text).toContain(decoy.like);
    }
  });
});
