import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProposalType } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  CONFUSABLE_SET_FILE,
  LINKER_V0,
  LINKING_ENTITIES,
  LinkingBaseline,
  type LinkingCase,
  linkingCase,
  linkingReport,
  parseConfusableSet,
  score,
  splitSummary,
} from "../src/linking";

const TEXT = readFileSync(new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url), "utf8");
const ITEMS = parseConfusableSet(TEXT);
const BASELINE = LinkingBaseline.parse(
  JSON.parse(readFileSync(new URL("../baselines/linking-v0.json", import.meta.url), "utf8")),
);

function v0(mention: string, type: ProposalType, kind: LinkingCase["kind"] = "company") {
  const reading = {
    transcript: mention,
    mention: { start: 0, end: mention.length, text: mention },
    company: null,
  };
  const [prediction] = LINKER_V0.predict(
    [{ id: "x", type, kind, biased: reading, unbiased: reading, focusEntityId: null, recent: [] }],
    LINKING_ENTITIES,
  );
  return prediction?.final;
}

describe("linker v0, Phase 3's exact matcher", () => {
  it("links an exact name or an alias only one record has, ignoring case", () => {
    expect(v0("Atmos Industrial", "note")).toEqual({
      decision: "linked",
      entityId: "co_009",
      p: null,
    });
    expect(v0("atmos", "task")?.entityId).toBe("co_009");
    expect(v0("Dana Li", "contact", "contact")?.entityId).toBe("ct_145");
  });

  it("gives no target for a shared alias, a misheard name, or a spoken deal name", () => {
    expect(v0("Northwind", "note")?.decision).toBe("none"); // three companies answer to it
    expect(v0("Atlis Freight", "note")?.decision).toBe("none");
    // The CRM calls it "Atmos Industrial - Onboarding package"; nobody says the dash.
    expect(v0("Atmos Industrial onboarding package", "deal_update", "deal")?.decision).toBe("none");
  });

  it("makes an unmatched contact new, as Phase 3's new_entity did, and trusts a spelling", () => {
    expect(v0("Tamzin Tanaka", "contact", "contact")?.decision).toBe("new"); // Tamsin Tanaka exists
    // "Katherine" is Lantern's spelling; Kathryn at Blue Harbor sounds the same, but v0 can't know.
    expect(v0("Katherine Moore", "contact", "contact")?.entityId).toBe("ct_078");
  });

  it("has no witness and no probability", () => {
    expect(LINKER_V0.witness).toBe(false);
    expect(LINKER_V0.gate).toBe(false);
    const predictions = LINKER_V0.predict(ITEMS.map(linkingCase), LINKING_ENTITIES);
    for (const prediction of predictions) {
      expect(prediction.final).toEqual(prediction.biased);
      expect(prediction.flagged).toBe(false);
      expect(prediction.final.p).toBeNull();
    }
  });

  it("scores today exactly as its committed baseline says (baselines/linking-v0.json)", () => {
    expect(BASELINE.setSha256).toBe(createHash("sha256").update(TEXT).digest("hex"));
    const scored = score(ITEMS, LINKER_V0.predict(ITEMS.map(linkingCase), LINKING_ENTITIES));
    for (const split of ["calibration", "test"] as const) {
      const report = linkingReport(
        scored.filter((row) => row.item.split === split),
        { linker: LINKER_V0.name, witness: false, set: BASELINE.set, split },
      );
      expect(splitSummary(report), split).toEqual(BASELINE.splits[split]);
    }
  });

  it("links every snapped new name in class E2 to a record that isn't there", () => {
    const e2 = ITEMS.filter((item) => item.class === "E2");
    const predictions = LINKER_V0.predict(e2.map(linkingCase), LINKING_ENTITIES);
    expect(predictions).toHaveLength(24);
    // The biased witness wrote a CRM name exactly, so an exact matcher links it, every time.
    for (const prediction of predictions) expect(prediction.final.decision).toBe("linked");
  });
});
