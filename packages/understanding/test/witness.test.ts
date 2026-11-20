// Comparing the two witnesses (spec §4.6, WP5) on a small CRM cut from the demo CRM's confusable
// groups: the unbiased reading by word timings and by alignment, the conflict rule and θ_d, and
// what a conflict does (a downgrade with merged candidates, or a flag). The confusable-name set's
// numbers with the witness live in @earshot/evals (linking-v1.test.ts).
import { describe, expect, it } from "vitest";
import {
  buildLinkIndex,
  type EntityKind,
  LINKER_PARAMS_V1,
  type LinkContext,
  type LinkEntity,
  type LinkerParams,
  link,
  outcomesDiffer,
  type ReadingOutcome,
  witnessConflict,
} from "../src/link";
import {
  compareWitnesses,
  coveredRange,
  MAX_DOWNGRADE_RECORDS,
  mergeCandidates,
  READING_PAD_MS,
  readingDistance,
  readUnbiased,
  type TimedWord,
  transcriptTokens,
  type UnbiasedMention,
  type WitnessUtterance,
} from "../src/witness";

const ENTITIES: readonly LinkEntity[] = [
  { id: "co_acme", kind: "company", name: "Acme Dynamics", aliases: ["Acme"] },
  { id: "co_acmi", kind: "company", name: "Acmi Dynamics", aliases: ["Acmi"] },
  { id: "co_akme", kind: "company", name: "Akme Dynamics", aliases: ["Akme"] },
  { id: "co_atlas", kind: "company", name: "Atlas Freight", aliases: ["Atlas"] },
  { id: "co_atmas", kind: "company", name: "Atmas Group", aliases: ["Atmas"] },
  { id: "co_atmos", kind: "company", name: "Atmos Industrial", aliases: ["Atmos"] },
  { id: "co_summit_cap", kind: "company", name: "Summit Ridge Capital", aliases: [] },
  { id: "co_summit_med", kind: "company", name: "Summit Ridge Medical", aliases: [] },
  { id: "co_basalt", kind: "company", name: "Basalt Mining", aliases: ["Basalt"] },
  { id: "ct_raj", kind: "contact", name: "Raj Patel", aliases: [], parentId: "co_basalt" },
  { id: "ct_dana_lee", kind: "contact", name: "Dana Lee", aliases: [], parentId: "co_basalt" },
  { id: "ct_dana_li", kind: "contact", name: "Dana Li", aliases: [], parentId: "co_atlas" },
  {
    id: "deal_atmos",
    kind: "deal",
    name: "Atmos Industrial - Onboarding package",
    aliases: [],
    parentId: "co_atmos",
  },
];
const INDEX = buildLinkIndex(ENTITIES);
const UTTERANCE = "0193b8a2-7c4e-7000-8000-00000000000a";

function context(
  options: { focus?: string; recent?: readonly string[]; params?: LinkerParams } = {},
): LinkContext {
  return {
    index: INDEX,
    focusEntityId: options.focus ?? null,
    recent: options.recent ?? [],
    turnMentions: [],
    params: options.params ?? LINKER_PARAMS_V1,
  };
}

/** The biased reading linked, then compared with the unbiased one. */
function compare(
  biasedText: string,
  unbiased: UnbiasedMention | null,
  kind: EntityKind,
  options: Parameters<typeof context>[0] & { field?: string; company?: string } = {},
) {
  const ctx = context(options);
  const mention = { text: biasedText, kind, companyText: options.company ?? null };
  const biased = link(mention, ctx);
  return {
    biased,
    comparison: compareWitnesses(
      { mention, biased, unbiased, ...(options.field ? { field: options.field } : {}) },
      ctx,
    ),
  };
}

/** A transcript without timings, as the alignment path reads it. */
function untimed(text: string): WitnessUtterance {
  return { utteranceId: UTTERANCE, text, startMs: 0, endMs: 9_000 };
}

/** A transcript with a word every so many ms, from `startMs`, each `length` ms long. */
function timed(text: string, startMs: number, step = 300, length = 280): WitnessUtterance {
  const words: TimedWord[] = text
    .split(" ")
    .map((w, k) => ({ w, startMs: startMs + k * step, endMs: startMs + k * step + length }));
  return {
    utteranceId: UTTERANCE,
    text,
    startMs,
    endMs: words.at(-1)?.endMs ?? startMs,
    words,
  };
}

/** The quote's span in a biased transcript, and the audio window it would have at 300 ms a word. */
function quote(text: string, quoted: string, startMs?: number) {
  const start = text.indexOf(quoted);
  if (start < 0) throw new Error(`"${quoted}" isn't in "${text}"`);
  const span: [number, number] = [start, start + quoted.length];
  if (startMs === undefined) return { text, span };
  const before = text.slice(0, start).split(" ").filter(Boolean).length;
  const words = quoted.split(" ").length;
  const audioMs: [number, number] = [
    startMs + before * 300,
    startMs + (before + words - 1) * 300 + 280,
  ];
  return { text, span, audioMs };
}

describe("the unbiased reading", () => {
  it("splits a transcript into words without the punctuation at their edges", () => {
    expect(
      transcriptTokens('Call "Acme," then Summit Ridge - they\'d said multi-year & more.'),
    ).toEqual([
      { text: "Call", start: 0, end: 4 },
      { text: "Acme", start: 6, end: 10 },
      { text: "then", start: 13, end: 17 },
      { text: "Summit", start: 18, end: 24 },
      { text: "Ridge", start: 25, end: 30 },
      { text: "they'd", start: 33, end: 39 },
      { text: "said", start: 40, end: 44 },
      { text: "multi-year", start: 45, end: 55 },
      { text: "&", start: 56, end: 57 },
      { text: "more", start: 58, end: 62 },
    ]);
    expect(transcriptTokens(" ... - ")).toEqual([]);
    // Code points, not UTF-16 units: an emoji at an edge goes, a letter outside the BMP stays.
    expect(transcriptTokens("\u{1F600}Acme\u{1F600} \u{1D49C}cme,")).toEqual([
      { text: "Acme", start: 2, end: 6 },
      { text: "\u{1D49C}cme", start: 9, end: 14 },
    ]);
  });

  it("trims edges in linear time, however long the punctuation run (CodeQL js/polynomial-redos)", () => {
    // An end-anchored regex retried from each '%' and took seconds here.
    const run = "%".repeat(200_000);
    const started = performance.now();
    const tokens = transcriptTokens(`a${run}b ${run}c${run}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(tokens.map((token) => token.text)).toEqual([`a${run}b`, "c"]);
  });

  it("reads by alignment without timings, and keeps what the biased stream dropped at the quote's edge", () => {
    const biased = "We told Atmos Industrial they'd get a reference call.";
    const reading = readUnbiased(
      quote(biased, "Atmos Industrial"),
      untimed("We told Atmo Systems they'd get a reference call."),
    );
    expect(reading).toEqual({
      text: "Atmo Systems",
      utteranceId: UTTERANCE,
      audioMs: [0, 9_000],
      method: "alignment",
    });
    // A tail the biased stream dropped is heard where nothing in the biased transcript is.
    const dropped = "Just got off a call with Summit Ridge, and they want a revised quote.";
    expect(
      readUnbiased(
        quote(dropped, "Summit Ridge"),
        untimed("Just got off a call with Summit Ridge Capital, and they want a revised quote."),
      )?.text,
    ).toBe("Summit Ridge Capital");
    expect(
      readUnbiased(
        quote("Northwind is pushing the kickoff.", "Northwind"),
        untimed("Northwind Labs is pushing the kickoff."),
      )?.text,
    ).toBe("Northwind Labs");
    // A word split in two, and the original spelling and punctuation between the words.
    expect(
      readUnbiased(
        quote("Ask Glovex and Maple & Vine Grocers.", "Maple & Vine Grocers"),
        untimed("Ask Glow Vex and Maple & Pine Grocers."),
      )?.text,
    ).toBe("Maple & Pine Grocers");
    expect(
      readUnbiased(quote("the Glovex deal", "Glovex"), untimed("the glow vex deal"))?.text,
    ).toBe("glow vex");
  });

  it("never starts or ends a reading with a filler, and takes in at most two inserted words a side", () => {
    expect(
      readUnbiased(quote("we met Acme today", "Acme"), untimed("we met um Acme uh today"))?.text,
    ).toBe("Acme");
    expect(
      readUnbiased(
        quote("I told Atmos they'd call", "Atmos"),
        untimed("I told Atmos Industrial Group Holdings Limited they'd call"),
      )?.text,
    ).toBe("Atmos Industrial Group");
    expect(coveredRange(["call", "Atmos", "now"], { from: 1, to: 1 }, ["call", "now"])).toBeNull();
    expect(
      coveredRange(["call", "Atmos", "now"], { from: 1, to: 1 }, ["call", "uh", "now"]),
    ).toBeNull();
  });

  it("is unavailable where the second witness has no words for the quote", () => {
    expect(readUnbiased(quote("call Atmos now", "Atmos"), untimed("call now"))).toBeNull();
    expect(readUnbiased(quote("call Atmos now", "Atmos"), untimed("..."))).toBeNull();
    expect(
      readUnbiased({ text: "call Atmos now", span: [40, 45] }, untimed("call Atmos now")),
    ).toBeNull();
  });

  it("reads by time within 150 ms of the quote, without the neighbouring words", () => {
    const biased = "We told Atmos Industrial they'd get a reference call";
    const window = quote(biased, "Atmos Industrial", 1_000);
    expect(window.audioMs).toEqual([1_600, 2_180]);
    const heard = timed("We told Atmo Systems they'd get a reference call", 1_000);
    expect(readUnbiased(window, heard)).toEqual({
      text: "Atmo Systems",
      utteranceId: UTTERANCE,
      audioMs: [1_600, 2_180],
      method: "time",
    });
    // Up to the pad either way, the two transcribers' clocks may disagree.
    for (const offset of [-READING_PAD_MS + 20, READING_PAD_MS - 20]) {
      expect(readUnbiased(window, timed(heard.text, 1_000 + offset))?.text, `${offset}`).toBe(
        "Atmo Systems",
      );
    }
    // The time window keeps a repeated name to the stretch the quote covers.
    const twice = "Atmos called and I told Atmos Industrial they'd get a call";
    expect(
      readUnbiased(
        quote(twice, "Atmos Industrial", 0),
        timed("Atmos called and I told Atmo Systems they'd get a call", 0),
      ),
    ).toMatchObject({ text: "Atmo Systems", audioMs: [1_500, 2_080] });
  });

  it("takes in, by time, a tail the biased stream dropped when it's heard right after the quote", () => {
    const biased = "a call with Summit Ridge and they want a quote";
    const window = quote(biased, "Summit Ridge", 0);
    const heard = timed("a call with Summit Ridge Capital and they want a quote", 0, 300, 300);
    expect(readUnbiased(window, heard)?.text).toBe("Summit Ridge Capital");
  });

  it("is unavailable by time when no unbiased word overlaps the quote itself", () => {
    const window = {
      text: "call Atmos now",
      span: [5, 10] as [number, number],
      audioMs: [1_000, 1_400] as [number, number],
    };
    const around: WitnessUtterance = {
      utteranceId: UTTERANCE,
      text: "call now",
      startMs: 600,
      endMs: 1_600,
      words: [
        { w: "call", startMs: 600, endMs: 990 },
        { w: "now", startMs: 1_410, endMs: 1_600 },
      ],
    };
    expect(readUnbiased(window, around)).toBeNull();
    // Without a window, or without word timings, it reads by alignment instead.
    expect(readUnbiased({ ...window, audioMs: null }, around)).toBeNull();
    expect(readUnbiased(window, { ...untimed("call Atmo now"), words: [] })?.method).toBe(
      "alignment",
    );
  });
});

describe("how differently two readings sound", () => {
  it("measures the codes the linker compares, homophones and split words alike", () => {
    expect(readingDistance("Akme", "Acme")).toBe(0);
    expect(readingDistance("Shawn Murphy", "Sean Murfy")).toBe(0);
    expect(readingDistance("Yara Under Hill", "Yara Underhill")).toBe(0);
    expect(readingDistance("Maple & Vine", "maple and vine")).toBe(0);
    expect(readingDistance("Atmos Industrial", "Atmos Industries")).toBeCloseTo(1 / 11, 9);
    expect(readingDistance("Raj Patel", "Ravi Patel")).toBeCloseTo(0.2, 9);
    expect(readingDistance("Atmos Industrial", "Atmo Systems")).toBeGreaterThan(0.3);
    expect(readingDistance("3", "3")).toBe(0);
    expect(readingDistance("3", "4")).toBe(1);
  });
});

describe("the conflict rule", () => {
  const linked = (entityId: string): ReadingOutcome => ({ decision: "linked", entityId });
  const NEW: ReadingOutcome = { decision: "new", entityId: null };
  const ASK: ReadingOutcome = { decision: "ask", entityId: null };
  const NONE: ReadingOutcome = { decision: "none", entityId: null };

  it("calls outcomes different when they don't reach the same decision", () => {
    expect(outcomesDiffer(linked("a"), linked("a"))).toBe(false);
    expect(outcomesDiffer(linked("a"), linked("b"))).toBe(true);
    expect(outcomesDiffer(linked("a"), NEW)).toBe(true);
    expect(outcomesDiffer(NEW, linked("a"))).toBe(true);
    // An undecided unbiased reading doesn't back a decided biased one.
    expect(outcomesDiffer(linked("a"), ASK)).toBe(true);
    expect(outcomesDiffer(NEW, ASK)).toBe(true);
    expect(outcomesDiffer(NEW, NEW)).toBe(false);
    // Two undecided readings are alike, asks and none included.
    expect(outcomesDiffer(ASK, ASK)).toBe(false);
    expect(outcomesDiffer(ASK, NONE)).toBe(false);
    expect(outcomesDiffer(ASK, linked("a"))).toBe(true);
  });

  it("needs a code distance of θ_d or more", () => {
    expect(witnessConflict(linked("a"), NEW, 0.2, 0.2)).toBe(true);
    expect(witnessConflict(linked("a"), NEW, 0.19, 0.2)).toBe(false);
    expect(witnessConflict(linked("a"), linked("a"), 1, 0.02)).toBe(false);
  });
});

describe("comparing the witnesses", () => {
  it('turns a link into a question when the biased witness snapped to "Atmos Industrial" and the unbiased one heard "Atmo Systems"', () => {
    const { biased, comparison } = compare("Atmos Industrial", { text: "Atmo Systems" }, "company");
    expect(biased).toMatchObject({ decision: "linked", entityId: "co_atmos", basis: "exact" });
    expect(comparison.outcome).toBe("conflict");
    expect(comparison.unbiased?.decision).toBe("new");
    expect(comparison.distance).toBeGreaterThanOrEqual(LINKER_PARAMS_V1.thresholds.thetaD);
    expect(comparison.flags).toEqual([{ kind: "witness_conflict", field: "target" }]);
    expect(comparison.downgrade?.decision).toBe("ask");
    expect(comparison.downgrade?.candidates.map((candidate) => candidate.entityId)).toEqual([
      "co_atmos",
      null,
      "deal_atmos",
      "co_atmas",
    ]);
  });

  it('finds no conflict when both heard "Akme", or two spellings of its sound', () => {
    for (const heard of ["Akme", "Acme", "Akmi"]) {
      const { biased, comparison } = compare("Akme", { text: heard }, "company", {
        recent: ["co_akme"],
      });
      expect(biased).toMatchObject({ decision: "linked", entityId: "co_akme" });
      expect(comparison, heard).toMatchObject({
        outcome: "agree",
        distance: 0,
        flags: [],
        downgrade: null,
      });
    }
  });

  it("calls an empty unbiased reading unavailable, and flags nothing", () => {
    for (const unbiased of [null, { text: "" }, { text: " ... " }]) {
      const { comparison } = compare("Atmos Industrial", unbiased, "company");
      expect(comparison).toEqual({
        field: "target",
        outcome: "unavailable",
        distance: null,
        unbiased: null,
        flags: [],
        downgrade: null,
      });
    }
  });

  it("keeps the old target first when it downgrades, a link or a new record", () => {
    // Class G: the open account is the wrong sibling; the unbiased witness heard the whole name.
    const sibling = compare("Summit Ridge", { text: "Summit Ridge Capital" }, "company", {
      focus: "co_summit_med",
    });
    expect(sibling.biased).toMatchObject({ decision: "linked", entityId: "co_summit_med" });
    expect(sibling.comparison.unbiased).toMatchObject({
      decision: "linked",
      entityId: "co_summit_cap",
    });
    expect(sibling.comparison.downgrade?.candidates.slice(0, 2).map((c) => c.entityId)).toEqual([
      "co_summit_med",
      "co_summit_cap",
    ]);
    // A new name the unbiased witness heard as a CRM name.
    const named = compare("Atmo Systems", { text: "Atmos Industrial" }, "company");
    expect(named.biased.decision).toBe("new");
    expect(named.comparison.downgrade?.candidates[0]).toEqual({
      entityId: null,
      p: named.biased.p,
    });
    expect(named.comparison.downgrade?.candidates[1]?.entityId).toBe("co_atmos");
    // A snapped contact: the old record, then "new".
    const snapped = compare("Raj Patel", { text: "Ravi Patel" }, "contact");
    expect(snapped.comparison.downgrade?.candidates.slice(0, 2).map((c) => c.entityId)).toEqual([
      "ct_raj",
      null,
    ]);
  });

  it("merges at most three records plus new, without repeats", () => {
    const { biased, comparison } = compare("Atmos Industrial", { text: "Atmo Systems" }, "company");
    const unbiased = comparison.unbiased;
    if (!unbiased) throw new Error("no unbiased result");
    const merged = mergeCandidates(biased, unbiased);
    expect(merged).toEqual(comparison.downgrade?.candidates);
    const ids = merged.map((candidate) => candidate.entityId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id !== null).length).toBeLessThanOrEqual(MAX_DOWNGRADE_RECORDS);
    expect(merged.length).toBeLessThanOrEqual(MAX_DOWNGRADE_RECORDS + 1);
    const crowded = {
      ...biased,
      candidates: ["co_atmos", "co_atmas", "co_atlas"].map((entityId) => ({ entityId, p: 0.3 })),
    };
    const other = {
      ...unbiased,
      decision: "linked" as const,
      entityId: "co_basalt",
      p: 0.9,
      candidates: [
        { entityId: "co_basalt", p: 0.9 },
        { entityId: null, p: 0.1 },
      ],
    };
    expect(mergeCandidates(crowded, other).map((candidate) => candidate.entityId)).toEqual([
      "co_atmos",
      "co_basalt",
      "co_atmas",
      null,
    ]);
  });

  it("flags an undecided target, or another field, without downgrading it", () => {
    const ask = compare("Atmas", { text: "Atlas" }, "company");
    expect(ask.biased.decision).toBe("ask");
    expect(ask.comparison).toMatchObject({
      outcome: "conflict",
      flags: [{ kind: "witness_conflict", field: "target" }],
      downgrade: null,
    });
    const name = compare("Raj Patel", { text: "Ravi Patel" }, "contact", { field: "name" });
    expect(name.comparison).toMatchObject({
      field: "name",
      outcome: "conflict",
      flags: [{ kind: "witness_conflict", field: "name" }],
      downgrade: null,
    });
  });

  it("conflicts only when the readings are θ_d or more apart", () => {
    const at = (thetaD: number) => ({
      ...LINKER_PARAMS_V1,
      thresholds: { ...LINKER_PARAMS_V1.thresholds, thetaD },
    });
    // "Raj Patel" and "Ravi Patel" are 0.2 apart.
    expect(
      compare("Raj Patel", { text: "Ravi Patel" }, "contact", { params: at(0.2) }).comparison
        .outcome,
    ).toBe("conflict");
    expect(
      compare("Raj Patel", { text: "Ravi Patel" }, "contact", { params: at(0.22) }).comparison
        .outcome,
    ).toBe("agree");
  });

  it("links the unbiased reading with the same context, the biased company standing in for a missing one", () => {
    const { biased, comparison } = compare("Dana Lee", { text: "Donna Leigh" }, "contact", {
      company: "Basalt",
    });
    expect(biased).toMatchObject({ decision: "linked", entityId: "ct_dana_lee" });
    expect(comparison.unbiased).toMatchObject({ decision: "linked", entityId: "ct_dana_lee" });
    expect(comparison.outcome).toBe("agree");
    const elsewhere = compare("Dana Lee", { text: "Dana Li", companyText: "Atlas" }, "contact", {
      company: "Basalt",
    });
    expect(elsewhere.comparison.unbiased).toMatchObject({ entityId: "ct_dana_li" });
    // They sound the same, so different records still don't make a conflict.
    expect(elsewhere.comparison.outcome).toBe("agree");
  });
});
