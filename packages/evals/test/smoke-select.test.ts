// The live smoke eval's set (Phase 4 WP11 step 1): smoke.json is the seeded pick's output today,
// it holds every stratum's minimum within the turn budget, and a perfect model would pass the
// absolute gates on it, which is why the linker's two known wrong accounts are left out.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSmokeSet, SMOKE_FILE } from "../scripts/smoke-io";
import { readErrorLabels, readUnderstandingCassettes } from "../scripts/understanding-io";
import {
  buildSmokeSet,
  SMOKE_EXCLUDED,
  SMOKE_MAX_TURNS,
  SMOKE_MINIMUMS,
  SMOKE_SEED,
  SMOKE_SIZE,
  type SmokeStratum,
  selectSmokeSet,
  serializeSmokeSet,
  smokeScripts,
  smokeShortfalls,
  smokeStrata,
  stratumCount,
} from "../src/smoke";
import { ALL_DEBRIEFS, runScript, understandingMetrics } from "../src/understanding";

describe("smoke.json", () => {
  it("is what `pnpm --filter @earshot/evals smoke:select` writes today (run it after changing the debriefs or the pick, then record the smoke baseline again)", () => {
    expect(serializeSmokeSet(buildSmokeSet(ALL_DEBRIEFS))).toBe(readFileSync(SMOKE_FILE, "utf8"));
  });

  it("lists 30 distinct debriefs, none of the excluded ones, with their strata as committed", () => {
    const set = readSmokeSet();
    expect(set.scripts).toHaveLength(SMOKE_SIZE);
    expect(new Set(set.scripts).size).toBe(SMOKE_SIZE);
    expect(set.seed).toBe(SMOKE_SEED);
    for (const id of Object.keys(SMOKE_EXCLUDED)) expect(set.scripts).not.toContain(id);
    const scripts = smokeScripts(set, ALL_DEBRIEFS);
    expect(set.strata).toEqual({ ...smokeStrata(scripts) });
  });

  it("holds every stratum's minimum, within the turn budget", () => {
    const strata = smokeStrata(smokeScripts(readSmokeSet(), ALL_DEBRIEFS));
    expect(smokeShortfalls(strata)).toEqual([]);
    expect(strata.turns).toBeLessThanOrEqual(SMOKE_MAX_TURNS);
    for (const [stratum, minimum] of Object.entries(SMOKE_MINIMUMS) as [SmokeStratum, number][]) {
      expect(stratumCount(strata, stratum), stratum).toBeGreaterThanOrEqual(minimum);
    }
    // The spec's strata, by name: every proposal type, confusable names, numbers, dates,
    // negations, and witness conflicts.
    for (const type of ["note", "task", "contact", "deal_update", "commitment", "meeting"]) {
      expect(strata.perType[type as keyof typeof strata.perType], type).toBeGreaterThan(0);
    }
    expect(strata.confusableMentions).toBeGreaterThan(0);
    expect(strata.numberTurns).toBeGreaterThan(0);
    expect(strata.relativeDates).toBeGreaterThan(0);
    expect(strata.negationTurns).toBeGreaterThan(0);
    expect(strata.witnessConflicts).toBeGreaterThan(0);
  });

  it("would let a model that drafts every turn right pass the absolute gates: no wrong account, full evidence", async () => {
    const labels = readErrorLabels();
    // The cassettes' seeded errors aside, their drafts are the ground truth.
    const cassettes = readUnderstandingCassettes();
    const runs = [];
    for (const script of smokeScripts(readSmokeSet(), ALL_DEBRIEFS)) {
      const cassette = cassettes.anthropic.cassettes[script.id];
      if (!cassette) throw new Error(`no cassette for ${script.id}`);
      runs.push(await runScript("anthropic", script, cassette, labels));
    }
    const metrics = understandingMetrics(runs, labels);
    expect(metrics.wrongAccount.n).toBe(0);
    expect(metrics.evidence.rate).toBe(1);
    expect(metrics.misses).toBe(0);
  }, 120_000); // about a second here; CI's runners under turbo are far slower

  it("leaves out only scripts where linker v1 links a snapped name wrongly even from perfect drafts", async () => {
    const labels = readErrorLabels();
    const cassettes = readUnderstandingCassettes();
    for (const id of Object.keys(SMOKE_EXCLUDED)) {
      const script = ALL_DEBRIEFS.find((candidate) => candidate.id === id);
      const cassette = cassettes.anthropic.cassettes[id];
      if (!script || !cassette) throw new Error(`no ${id}`);
      const metrics = understandingMetrics(
        [await runScript("anthropic", script, cassette, labels)],
        labels,
      );
      expect(metrics.wrongAccount.n, id).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe("the pick", () => {
  it("is reproducible, and another seed still meets every minimum", () => {
    expect(selectSmokeSet(ALL_DEBRIEFS)).toEqual(selectSmokeSet(ALL_DEBRIEFS));
    const other = selectSmokeSet(ALL_DEBRIEFS, 1);
    expect(other).toHaveLength(SMOKE_SIZE);
    const byId = new Map(ALL_DEBRIEFS.map((script) => [script.id, script]));
    expect(
      smokeShortfalls(
        smokeStrata(other.map((id) => byId.get(id) as (typeof ALL_DEBRIEFS)[number])),
      ),
    ).toEqual([]);
  }, 120_000); // three picks over 200 scripts: well under a second here

  it("names what a thin set lacks", () => {
    const short = smokeShortfalls(smokeStrata(ALL_DEBRIEFS.slice(0, 3)));
    expect(short).toEqual(
      expect.arrayContaining([
        expect.stringContaining("meeting"),
        expect.stringContaining("witnessConflicts"),
        expect.stringContaining("misheardNames"),
      ]),
    );
  });

  it("fails loudly when the debriefs can't meet the minimums", () => {
    expect(() => selectSmokeSet(ALL_DEBRIEFS.slice(0, 40))).toThrow(/minimums/);
  });
});
