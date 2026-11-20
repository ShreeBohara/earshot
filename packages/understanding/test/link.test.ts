// The entity linker (spec §4.4, WP4) on a small CRM cut from the demo CRM's confusable groups:
// the index, each candidate source, the features, the decision rule and its grid search, the
// model, the committed parameters, and `link` itself. The confusable-name set's numbers, the
// fit's reproducibility, and the 250-record timing live in @earshot/evals (linking-v1.test.ts).
import { describe, expect, it } from "vitest";
import {
  buildLinkIndex,
  CANDIDATE_SOURCES,
  type CandidateSource,
  candidateProbabilities,
  candidateRows,
  decide,
  type EntityKind,
  FEATURE_NAMES,
  finalDecision,
  findCandidates,
  fitLogistic,
  type GridItem,
  isLinkUncertain,
  LINKER_PARAMS_V1,
  type LinkEntity,
  type LinkerParams,
  link,
  parseLinkerParams,
  prepareMention,
  searchThresholds,
  sigmoid,
  THRESHOLD_GRID,
} from "../src/link";
import { similarity } from "../src/names";
import { mulberry32, mutateName, randomName } from "./support/random";

const ENTITIES: readonly LinkEntity[] = [
  { id: "co_acme", kind: "company", name: "Acme Dynamics", aliases: ["Acme"] },
  { id: "co_acmi", kind: "company", name: "Acmi Dynamics", aliases: ["Acmi"] },
  { id: "co_akme", kind: "company", name: "Akme Dynamics", aliases: ["Akme"] },
  { id: "co_atlas", kind: "company", name: "Atlas Freight", aliases: ["Atlas"] },
  { id: "co_atmas", kind: "company", name: "Atmas Group", aliases: ["Atmas"] },
  { id: "co_atmos", kind: "company", name: "Atmos Industrial", aliases: ["Atmos"] },
  { id: "co_knight", kind: "company", name: "Knight Security", aliases: ["Knight"] },
  { id: "co_nite", kind: "company", name: "Nite Security Group", aliases: ["Nite"] },
  { id: "co_meridian", kind: "company", name: "Meridian Supply Co", aliases: ["Meridian", "MSC"] },
  { id: "co_midland", kind: "company", name: "Midland Steel Corp", aliases: ["Midland", "MSC"] },
  { id: "co_nw_foods", kind: "company", name: "Northwind Foods", aliases: ["Northwind"] },
  { id: "co_nw_labs", kind: "company", name: "Northwind Labs", aliases: ["Northwind"] },
  { id: "co_nw_logistics", kind: "company", name: "Northwind Logistics", aliases: ["Northwind"] },
  { id: "co_basalt", kind: "company", name: "Basalt Mining", aliases: ["Basalt"] },
  { id: "ct_sean", kind: "contact", name: "Sean Murphy", aliases: [], parentId: "co_basalt" },
  { id: "ct_shawn", kind: "contact", name: "Shawn Murphy", aliases: [], parentId: "co_knight" },
  { id: "ct_shaun", kind: "contact", name: "Shaun Murphy", aliases: [], parentId: "co_nw_foods" },
  {
    id: "deal_atmos",
    kind: "deal",
    name: "Atmos Industrial - Onboarding package",
    aliases: [],
    parentId: "co_atmos",
  },
  {
    id: "deal_atmas",
    kind: "deal",
    name: "Atmas Group - Expansion",
    aliases: [],
    parentId: "co_atmas",
  },
  {
    id: "deal_acme",
    kind: "deal",
    name: "Acme Dynamics - Expansion",
    aliases: [],
    parentId: "co_acme",
  },
];
const INDEX = buildLinkIndex(ENTITIES);
const ALL: readonly EntityKind[] = ["company", "contact", "deal"];

function candidates(
  text: string,
  options: {
    sources?: readonly CandidateSource[];
    kinds?: readonly EntityKind[];
    focus?: string;
    recent?: readonly string[];
  } = {},
) {
  return findCandidates(prepareMention(text), INDEX, {
    kinds: options.kinds ?? ALL,
    focusEntityId: options.focus ?? null,
    recent: new Set(options.recent ?? []),
    ...(options.sources ? { sources: options.sources } : {}),
  });
}

const ids = (found: ReturnType<typeof candidates>) => found.map((c) => c.record.entity.id);

function linked(
  text: string,
  kind: EntityKind | null,
  options: {
    kinds?: readonly EntityKind[];
    focus?: string;
    recent?: readonly string[];
    company?: string;
    params?: LinkerParams;
  } = {},
) {
  return link(
    { text, kind, companyText: options.company ?? null },
    {
      index: INDEX,
      focusEntityId: options.focus ?? null,
      recent: options.recent ?? [],
      turnMentions: [],
      params: options.params ?? LINKER_PARAMS_V1,
      ...(options.kinds ? { kinds: options.kinds } : {}),
    },
  );
}

function rows(text: string, kind: EntityKind | null, company?: string) {
  return candidateRows(
    { text, kind, companyText: company ?? null },
    { index: INDEX, focusEntityId: null, recent: [], turnMentions: [] },
  );
}

describe("buildLinkIndex", () => {
  it("reads a deal as its company and tail, since nobody says the CRM's dash", () => {
    const deal = INDEX.byId.get("deal_atmos");
    expect(deal?.forms.map((form) => `${form.role}: ${form.phrase.text}`)).toEqual([
      "name: atmos industrial onboarding package",
      "spoken: atmos onboarding package",
      "company: atmos industrial",
      "company: atmos",
    ]);
    expect(deal?.tail.map((word) => word.text)).toEqual(["onboarding", "package"]);
  });

  it("knows which records share a form, and a company's initials and abbreviation aliases", () => {
    expect(INDEX.byForm.get("northwind")?.map((record) => record.entity.id)).toEqual([
      "co_nw_foods",
      "co_nw_labs",
      "co_nw_logistics",
    ]);
    expect(INDEX.byAbbreviation.get("msc")?.map((record) => record.entity.id)).toEqual([
      "co_meridian",
      "co_midland",
    ]);
    expect(INDEX.children.get("co_atmos")?.map((record) => record.entity.id)).toEqual([
      "deal_atmos",
    ]);
  });

  it("marks the words that tell a record from its sound-alike siblings", () => {
    const labs = INDEX.byId.get("co_nw_labs");
    expect(labs?.tail.map((word) => word.text)).toEqual(["northwind", "labs"]);
    expect(labs?.distinguishing).toEqual([false, true]);
    // Atmas Group shares its head's sound with Atmos Industrial, not with Atlas Freight.
    expect(INDEX.byId.get("co_atmas")?.distinguishing).toEqual([false, true]);
    expect(INDEX.byId.get("co_atlas")?.distinguishing).toEqual([true, true]);
    // Homophones share every word: then every word counts.
    expect(INDEX.byId.get("co_acme")?.distinguishing).toEqual([true, true]);
  });
});

describe("candidate sources", () => {
  it('finds Acme Dynamics for "Akme" through sound (AKM), and Akme Dynamics exactly', () => {
    expect(ids(candidates("Akme", { sources: ["sound"] }))).toContain("co_acme");
    const found = candidates("Akme");
    expect(found.find((c) => c.record.entity.id === "co_acme")?.sources).toContain("sound");
    expect(found.find((c) => c.record.entity.id === "co_acme")?.sources).not.toContain("exact");
    expect(found.find((c) => c.record.entity.id === "co_akme")?.sources).toContain("exact");
  });

  it('finds Knight Security for "Nite" through sound alone: they share no trigram', () => {
    expect(similarity("Nite", "Knight")).toBe(0);
    const knight = candidates("Nite").find((c) => c.record.entity.id === "co_knight");
    expect(knight?.sources).toEqual(["sound", "homophone"]);
    expect(ids(candidates("Nite", { sources: ["trigram"] }))).not.toContain("co_knight");
  });

  it('keeps "Atlas" apart from "Atmas" (ATLS against ATMS)', () => {
    expect(ids(candidates("Atlas", { sources: ["sound", "homophone"] }))).toEqual(["co_atlas"]);
    expect(ids(candidates("Atmas", { sources: ["sound", "homophone"] }))).not.toContain("co_atlas");
    // Trigrams do bring Atlas in for "Atmas", but it doesn't sound like it or tie with it.
    const atlas = rows("Atmas", "company").find((row) => row.entityId === "co_atlas");
    expect(atlas?.features.phonFull).toBeCloseTo(0.75, 9);
    expect(atlas?.features.phonHead).toBe(0);
    for (const row of rows("Atmas", "company")) {
      if (row.entityId === "co_atmas" || row.entityId === "co_atmos") {
        expect(row.features.tieCount).toBeCloseTo(Math.log(2), 9); // each other, not Atlas
      }
    }
    expect(linked("Atlas", "company")).toMatchObject({ decision: "linked", entityId: "co_atlas" });
  });

  it("finds Shawn and Shaun Murphy for Sean through the homophone list (SN against XN)", () => {
    expect(ids(candidates("Sean", { sources: ["sound"] }))).toEqual(["ct_sean"]);
    expect(ids(candidates("Sean", { sources: ["homophone"] }))).toEqual([
      "ct_sean",
      "ct_shawn",
      "ct_shaun",
    ]);
    const murphys = rows("Sean Murphy", "contact").filter((row) => row.kind === "contact");
    expect(murphys.map((row) => row.features.phonFull)).toEqual([1, 1, 1]);
    for (const row of murphys) expect(row.features.tieCount).toBeCloseTo(Math.log(3), 9);
  });

  it("finds initials however they're spelled, and an open account's family for one word", () => {
    expect(ids(candidates("M. S. C."))).toEqual(
      expect.arrayContaining(["co_meridian", "co_midland"]),
    );
    const family = candidates("Onboarding", { focus: "co_atmos" });
    expect(family.find((c) => c.record.entity.id === "co_atmos")?.sources).toEqual(["family"]);
    expect(family.find((c) => c.record.entity.id === "deal_atmos")?.sources).toContain("family");
    expect(ids(candidates("Onboarding package", { focus: "co_atmos" }))).not.toContain("co_atmos");
  });

  it("keeps only the kinds the proposal type allows, and at most 8", () => {
    expect(
      new Set(candidates("Atmas", { kinds: ["deal"] }).map((c) => c.record.entity.kind)),
    ).toEqual(new Set(["deal"]));
    for (const text of ["Northwind Acme Atmas Knight", "Murphy", "Dynamics Group"]) {
      expect(candidates(text).length).toBeLessThanOrEqual(8);
    }
  });
});

describe("features", () => {
  it("gives a deal's tail its due, and context its sign", () => {
    const deals = candidateRows(
      { text: "Atmas onboarding", kind: "deal" },
      { index: INDEX, focusEntityId: null, recent: [], turnMentions: [], kinds: ["deal"] },
    );
    expect(deals.find((row) => row.entityId === "deal_atmos")?.features.tailCover).toBe(0.5);
    expect(deals.find((row) => row.entityId === "deal_atmas")?.features.tailCover).toBe(0);

    const withCompany = rows("Shawn Murphy", "contact", "Knight Security");
    expect(withCompany.find((row) => row.entityId === "ct_shawn")?.features.parentCtx).toBe(1);
    expect(withCompany.find((row) => row.entityId === "ct_sean")?.features.parentCtx).toBe(-1);
    // The losers of a group the company separated know it.
    expect(withCompany.find((row) => row.entityId === "ct_sean")?.features.rivalContext).toBe(1);
    expect(rows("Shawn Murphy", "contact").every((row) => row.features.parentCtx === 0)).toBe(true);
  });

  it("lets spelling separate nothing that sounds the same", () => {
    const [akme, acme] = ["co_akme", "co_acme"].map((id) =>
      rows("Akme Dynamics", "company").find((row) => row.entityId === id),
    );
    expect(akme?.exactRole).toBe("name");
    expect(acme?.exactRole).toBeNull();
    expect(acme?.features.exact).toBe(akme?.features.exact);
    expect(acme?.features.trgm).toBe(akme?.features.trgm);
  });

  it("stays in range on any mention", () => {
    const random = mulberry32(4);
    for (let n = 0; n < 200; n++) {
      const text = n % 2 === 0 ? randomName(random) : mutateName(random, randomName(random));
      for (const row of rows(text, n % 3 === 0 ? null : "company")) {
        expect(Object.keys(row.features)).toEqual([...FEATURE_NAMES]);
        for (const [name, value] of Object.entries(row.features)) {
          const [low, high] =
            name === "parentCtx" ? [-1, 1] : name === "tieCount" ? [0, Math.log(8)] : [0, 1];
          expect(value, name).toBeGreaterThanOrEqual(low - 1e-12);
          expect(value, name).toBeLessThanOrEqual(high + 1e-12);
        }
      }
    }
  });
});

describe("the decision rule", () => {
  const thresholds = { tauLink: 0.8, delta: 0.2, tauNew: 0.3, thetaD: 0.1 };

  it("links a clear winner, and asks on a tie at any height", () => {
    expect(decide([0.95, 0.1], true, thresholds)).toBe("linked");
    expect(decide([0.9, 0.9], true, thresholds)).toBe("ask");
    expect(decide([0.85, 0.7], true, thresholds)).toBe("ask"); // margin under δ
    expect(decide([0.2, 0.2], true, thresholds)).toBe("ask"); // a low tie isn't "new"
  });

  it("makes an empty list new or none, and never makes a deal new", () => {
    expect(decide([], true, thresholds)).toBe("new");
    expect(decide([], false, thresholds)).toBe("none");
    expect(decide([0.05, 0.01], true, thresholds)).toBe("new");
    expect(decide([0.05, 0.01], false, thresholds)).toBe("ask");
    expect(linked("Zephyr Renewal", "deal", { kinds: ["deal"] }).decision).toBe("none");
    expect(linked("Atmas", "deal", { kinds: ["deal"] }).decision).not.toBe("new");
    expect(linked("Zephyr Renewal", null).decision).toBe("none"); // an unknown kind is never new
    expect(linked("Zephyr Renewal", "company").decision).toBe("new");
  });

  it("searches the spec's grid, and θ_d, for the most correct decisions within the limits", () => {
    expect(THRESHOLD_GRID.tauLink).toHaveLength(15);
    expect(THRESHOLD_GRID.tauLink[0]).toBe(0.7);
    expect(THRESHOLD_GRID.tauLink.at(-1)).toBe(0.98);
    expect(THRESHOLD_GRID.delta).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
    expect(THRESHOLD_GRID.tauNew).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
    expect(THRESHOLD_GRID.thetaD).toHaveLength(20);
    expect(THRESHOLD_GRID.thetaD[0]).toBe(0.02);
    expect(THRESHOLD_GRID.thetaD.at(-1)).toBe(0.4);
    const item = (p: number[], gold: string | null, newAllowed = true): GridItem => ({
      p,
      ids: p.map((_, k) => `r${k}`),
      newAllowed,
      gold,
    });
    const items = [
      ...Array.from({ length: 50 }, () => item([0.99, 0.01], "r0")),
      item([0.75, 0.1], "r1"), // linked only below τ_link 0.75, and wrongly
      item([0.75, 0.1], "r0"),
      item([0.05], null),
      // A snapped new name: an exact-looking link the witness's "new" reading turns into a question.
      { ...item([0.99], null), witness: { p: [], ids: [], distance: 0.5 } },
    ];
    const result = searchThresholds(items, {
      maxWrongAccountRate: 0.015,
      maxNewWhenExistingRate: 0.05,
    });
    expect(result.feasible).toBe(true);
    expect(result.thresholds.tauLink).toBeGreaterThan(0.75);
    expect(result.decided).toBe(51); // 50 links and the new one; the witness stops the snap
    expect(result.wrongLinks).toBe(0);
    expect(result.points).toBe(15 * 8 * 7 * 20);
    const strict = searchThresholds(items, { maxWrongAccountRate: 0, maxNewWhenExistingRate: 0 });
    expect(strict.feasible).toBe(true);
    const impossible = searchThresholds([item([0.99, 0.01], "r1")], {
      maxWrongAccountRate: 0,
      maxNewWhenExistingRate: 0,
    });
    expect(impossible.feasible).toBe(false);
  });

  it("decides after the witness: a conflict at θ_d or more downgrades, an unavailable reading never does", () => {
    const thresholds = { tauLink: 0.8, delta: 0.2, tauNew: 0.3, thetaD: 0.1 };
    const snapped: GridItem = {
      p: [0.99],
      ids: ["r0"],
      newAllowed: true,
      gold: null,
      witness: { p: [], ids: [], distance: 0.1 },
    };
    expect(finalDecision(snapped, thresholds)).toBe("ask");
    expect(
      finalDecision({ ...snapped, witness: { p: [], ids: [], distance: 0.09 } }, thresholds),
    ).toBe("linked");
    expect(finalDecision({ ...snapped, witness: null }, thresholds)).toBe("linked");
    // The same record heard two ways is no conflict; an undecided biased reading stays as it is.
    expect(
      finalDecision({ ...snapped, witness: { p: [0.95], ids: ["r0"], distance: 0.5 } }, thresholds),
    ).toBe("linked");
    expect(
      finalDecision(
        {
          ...snapped,
          p: [0.5, 0.5],
          ids: ["r0", "r1"],
          witness: { p: [0.99], ids: ["r0"], distance: 0.5 },
        },
        thresholds,
      ),
    ).toBe("ask");
  });

  it("won't buy coverage with a snapped name the witness could catch", () => {
    // 100 right links, and one snap the witness hears 0.09 away: θ_d at 0.10 or more lets it
    // through as a wrong link (1 in 101, within the 1.5% limit) for one more decision.
    const items: GridItem[] = [
      ...Array.from({ length: 100 }, () => ({
        p: [0.99],
        ids: ["r0"],
        newAllowed: true,
        gold: "r0",
      })),
      {
        p: [0.99],
        ids: ["r0"],
        newAllowed: true,
        gold: null,
        witness: { p: [], ids: [], distance: 0.09 },
      },
    ];
    const result = searchThresholds(items, {
      maxWrongAccountRate: 0.015,
      maxNewWhenExistingRate: 0.05,
    });
    expect(result.thresholds.thetaD).toBe(0.02);
    expect(result.wrongLinks).toBe(0);
    expect(result.decided).toBe(100);
  });
});

describe("the model", () => {
  function synthetic(seed: number, n: number) {
    const random = mulberry32(seed);
    const x: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const row = [random(), random() < 0.3 ? 1 : 0, random() * 2];
      const z = -1 + 3 * (row[0] ?? 0) + 2 * (row[1] ?? 0) - 1.5 * (row[2] ?? 0);
      x.push(row);
      y.push(random() < sigmoid(z) ? 1 : 0);
    }
    return { x, y };
  }

  it("fits the same weights every time", () => {
    const { x, y } = synthetic(7, 400);
    expect(fitLogistic(x, y)).toEqual(fitLogistic(x, y));
  });

  it("recovers a known model, and stays finite on separable data", () => {
    const { x, y } = synthetic(11, 20_000);
    const fit = fitLogistic(x, y, { lambda: 1 });
    expect(fit.converged).toBe(true);
    expect(fit.bias).toBeCloseTo(-1, 0);
    expect(fit.weights[0]).toBeCloseTo(3, 0);
    expect(fit.weights[1]).toBeCloseTo(2, 0);
    expect(fit.weights[2]).toBeCloseTo(-1.5, 0);
    const separable = fitLogistic([[0], [0.1], [0.2], [0.8], [0.9], [1]], [0, 0, 0, 1, 1, 1]);
    expect(separable.converged).toBe(true);
    expect(Number.isFinite(separable.weights[0])).toBe(true);
    expect(separable.weights[0]).toBeGreaterThan(0);
  });
});

describe("the committed parameters", () => {
  it("name every feature and source, with thresholds from the spec's grid", () => {
    expect(LINKER_PARAMS_V1.version).toBe("linker.v1");
    expect(LINKER_PARAMS_V1.features).toEqual([...FEATURE_NAMES]);
    expect(LINKER_PARAMS_V1.sources).toEqual([...CANDIDATE_SOURCES]);
    const { tauLink, delta, tauNew, thetaD } = LINKER_PARAMS_V1.thresholds;
    expect(THRESHOLD_GRID.tauLink).toContain(tauLink);
    expect(THRESHOLD_GRID.delta).toContain(delta);
    expect(THRESHOLD_GRID.tauNew).toContain(tauNew);
    expect(THRESHOLD_GRID.thetaD).toContain(thetaD);
    expect(LINKER_PARAMS_V1.provenance?.calibration.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(LINKER_PARAMS_V1.provenance?.fittedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuse a parameter set that doesn't add up", () => {
    const good = { ...LINKER_PARAMS_V1 };
    expect(() => parseLinkerParams({ ...good, features: ["exact", "loudness"] })).toThrow(
      /unknown feature loudness/,
    );
    expect(() => parseLinkerParams({ ...good, weights: { exact: 1 } })).toThrow(/finite/);
    expect(() =>
      parseLinkerParams({
        ...good,
        thresholds: { tauLink: 1.2, delta: 0.1, tauNew: 0.1, thetaD: 0.1 },
      }),
    ).toThrow(/tauLink/);
    expect(() =>
      parseLinkerParams({ ...good, thresholds: { tauLink: 0.8, delta: 0.1, tauNew: 0.1 } }),
    ).toThrow(/thetaD/);
    expect(() => parseLinkerParams({ ...good, sources: ["exact", "exact"] })).toThrow(/twice/);
  });
});

describe("link", () => {
  it("links an exact name that nothing sounds like", () => {
    const result = linked("Nite Security Group", "company");
    expect(result).toMatchObject({ decision: "linked", entityId: "co_nite", basis: "exact" });
    expect(result.candidates[0]).toEqual({ entityId: "co_nite", p: result.p });
    expect(isLinkUncertain(result)).toBe(false);
  });

  it("asks among homophones nothing separates, and never calls them new", () => {
    for (const [text, kind, group] of [
      ["Akme Dynamics", "company", ["co_acme", "co_acmi", "co_akme"]],
      ["Northwind", "company", ["co_nw_foods", "co_nw_labs", "co_nw_logistics"]],
      ["MSC", "company", ["co_meridian", "co_midland"]],
      ["Sean Murphy", "contact", ["ct_sean", "ct_shawn", "ct_shaun"]],
    ] as const) {
      const result = linked(text, kind);
      expect(result.decision, text).toBe("ask");
      // The group, and nothing else that matters (a far-off third may trail at p ≈ 0).
      const records = result.candidates.filter(
        (candidate) => candidate.entityId !== null && candidate.p > 0.01,
      );
      expect(records.map((candidate) => candidate.entityId).sort(), text).toEqual(
        [...group].sort(),
      );
      for (const candidate of records) expect(candidate.p).toBeCloseTo(1 / group.length, 2);
    }
  });

  it("lets context decide between sound-alikes, and says so", () => {
    expect(linked("Akme Dynamics", "company", { focus: "co_acme" })).toMatchObject({
      decision: "linked",
      entityId: "co_acme",
      basis: "context",
    });
    expect(linked("Northwind", "company", { recent: ["co_nw_labs"] })).toMatchObject({
      decision: "linked",
      entityId: "co_nw_labs",
      basis: "context",
    });
    expect(
      linked("Shawn Murphy", "contact", { kinds: ["contact"], company: "Knight Security" }),
    ).toMatchObject({ decision: "linked", entityId: "ct_shawn", basis: "context" });
  });

  it("resolves a deal by its spoken name, and one named by its company through context", () => {
    expect(linked("Atmos onboarding", "deal", { kinds: ["deal"] })).toMatchObject({
      decision: "linked",
      entityId: "deal_atmos",
      basis: "sound",
    });
    expect(linked("Atmos", "deal", { kinds: ["deal"], focus: "co_atmos" })).toMatchObject({
      decision: "linked",
      entityId: "deal_atmos",
      basis: "context",
    });
  });

  it("proposes a new record for a name like nothing in the CRM", () => {
    expect(linked("Brightwater Ceramics", "company")).toMatchObject({
      decision: "new",
      entityId: null,
      candidates: [{ entityId: null, p: 1 }],
    });
    expect(linked("Hiroshi Vance", "contact", { kinds: ["contact"] }).decision).toBe("new");
  });

  it("gives none for a mention with no words", () => {
    expect(linked("—", "company")).toEqual({
      decision: "none",
      entityId: null,
      p: null,
      basis: null,
      candidates: [],
    });
  });

  it("keeps its contract on any mention: p in [0, 1], at most 4 candidates, most likely first", () => {
    const random = mulberry32(19);
    const kinds: (EntityKind | null)[] = ["company", "contact", "deal", null];
    for (let n = 0; n < 300; n++) {
      const text = n % 2 === 0 ? randomName(random) : mutateName(random, randomName(random));
      const result = linked(text, kinds[n % 4] ?? null, {
        ...(n % 5 === 0 ? { focus: "co_atmos" } : {}),
        ...(n % 7 === 0 ? { recent: ["co_nw_labs"] } : {}),
      });
      expect(result.entityId !== null, text).toBe(result.decision === "linked");
      expect(result.basis !== null, text).toBe(result.decision === "linked");
      expect(result.candidates.length, text).toBeLessThanOrEqual(4);
      if (result.p !== null) {
        expect(result.p).toBeGreaterThanOrEqual(0);
        expect(result.p).toBeLessThanOrEqual(1);
      }
      let previous = Number.POSITIVE_INFINITY;
      let total = 0;
      for (const candidate of result.candidates) {
        expect(candidate.p).toBeGreaterThanOrEqual(0);
        expect(candidate.p).toBeLessThanOrEqual(previous + 1e-12);
        previous = candidate.p;
        if (candidate.entityId !== null) total += candidate.p;
      }
      expect(total).toBeLessThanOrEqual(1 + 1e-9);
      if (result.decision === "linked")
        expect(result.candidates[0]?.entityId).toBe(result.entityId);
    }
  });

  it("scales candidates' probabilities to sum to 1 only when they sum past it", () => {
    const tied = rows("Northwind", "company");
    const p = candidateProbabilities(LINKER_PARAMS_V1, tied);
    expect(p.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1 + 1e-12);
    const clear = rows("Nite Security Group", "company");
    expect(candidateProbabilities(LINKER_PARAMS_V1, clear)[0]).toBeGreaterThan(0.9);
  });
});
