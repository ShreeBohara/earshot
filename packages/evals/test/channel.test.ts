import { companies, contacts } from "@earshot/demo-crm";
import { describe, expect, it } from "vitest";
import {
  alignPhrase,
  areHomophones,
  CHANNEL_PARAMS,
  commonSpelling,
  createRng,
  HOMOPHONES,
  hearBiased,
  hearUnbiased,
  keytermListV1,
  MISHEAR_OPS,
  mulberry32,
  opCandidates,
  sameSoundPhrase,
  snapToKeyterms,
  soundWords,
  subSeed,
  wordsLikeness,
} from "../src/channel";
import { LINKING_ENTITIES } from "../src/linking";

const NAMES = [
  ...companies.map((row) => ({ text: row.name, kind: "company" as const })),
  ...contacts.map((row) => ({
    text: `${row.firstName} ${row.lastName}`,
    kind: "contact" as const,
  })),
];

describe("the seeded stream", () => {
  it("is @earshot/demo-crm's mulberry32: the same seed gives the same numbers", () => {
    // From packages/demo-crm/scripts/build.ts, mulberry32(0x6a09e667).
    const next = mulberry32(0x6a09e667);
    expect([next(), next(), next(), next()]).toEqual([
      0.41696262010373175, 0.9287681325804442, 0.7078936931211501, 0.9262458968441933,
    ]);
  });

  it("draws integers in range, picks, shuffles, and weighs deterministically", () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 200; i++) {
      const value = a.int(2, 5);
      expect(value).toBe(b.int(2, 5));
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(5);
    }
    expect(createRng(3).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(() => createRng(1).pick([])).toThrow(RangeError);
    const rng = createRng(11);
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 3000; i++) counts[rng.weighted({ a: 1, b: 2, c: 0 })]++;
    expect(counts.c).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(1.7);
    expect(counts.b / counts.a).toBeLessThan(2.3);
    expect(subSeed(1, "class:A")).not.toBe(subSeed(1, "class:B"));
  });
});

describe("the homophone list", () => {
  it("puts every word in one set, and knows what Double Metaphone misses", () => {
    const words = HOMOPHONES.flat().map((word) => word.toLowerCase());
    expect(new Set(words).size).toBe(words.length);
    expect(areHomophones("Sean", "shawn")).toBe(true); // SN against XN
    expect(areHomophones("Pier", "Peer")).toBe(true);
    expect(areHomophones("Pier", "Pierce")).toBe(false);
    expect(commonSpelling("Akme")).toBe("Acme");
    expect(commonSpelling("Okafor")).toBe("Okafor");
  });
});

describe("sound", () => {
  it("calls words the same, near, or far", () => {
    expect(wordsLikeness("Nite", "Knight")).toBe("same");
    expect(wordsLikeness("Sean", "Shawn")).toBe("same");
    expect(wordsLikeness("Akme", "Acme")).toBe("same");
    expect(wordsLikeness("Atmas", "Atlas")).toBe("near"); // ATMS / ATLS
    expect(wordsLikeness("Lane", "Lake")).toBe("near"); // LN / LK
    expect(wordsLikeness("Pierce", "Pier")).toBe("near"); // PRS / PR
    expect(wordsLikeness("Kestrel", "Copperleaf")).toBe("far");
  });

  it("lines phrases up across splits, joins, and dropped tails", () => {
    expect(sameSoundPhrase("Glow Vex Systems", "Glovex Systems")).toBe(true);
    expect(sameSoundPhrase("North Wind Labs", "Northwind Labs")).toBe(true);
    expect(sameSoundPhrase("Quarrylane Media", "Quarry Lane Media")).toBe(true);
    expect(sameSoundPhrase("Maple and Vine Grocers", "Maple & Vine Grocers")).toBe(true);
    expect(sameSoundPhrase("Midland Steel", "Midland Steel Corp")).toBe(true);
    expect(sameSoundPhrase("Juniper Bay", "Juniper Bay Telecom")).toBe(false);
    const juniper = alignPhrase(soundWords("Juniper Bay"), soundWords("Juniper Bay Telecom"), {
      prefix: true,
      maxNear: 0,
    });
    expect(juniper).toEqual({ near: 0, distance: 0, matched: 2 });
  });

  it("never lets a joined pair be merely near: two words don't snap onto one", () => {
    const words = soundWords("Harborview Hotels");
    expect(alignPhrase(words, soundWords("Harborview"), { prefix: false, maxNear: 1 })).toBeNull();
    const near = alignPhrase(words, soundWords("Harborview Health"), { prefix: false, maxNear: 1 });
    expect(near?.near).toBe(1);
  });
});

describe("the mishearing rules", () => {
  it("keep every word's sound when they say they do, on every demo CRM name", () => {
    for (const { text, kind } of NAMES) {
      for (const op of [
        "homophone",
        "commonSpelling",
        "vowel",
        "consonant",
        "split",
        "join",
      ] as const) {
        for (const candidate of opCandidates(op, text, kind)) {
          expect(sameSoundPhrase(candidate, text), `${op}: ${text} → ${candidate}`).toBe(true);
        }
      }
    }
  });

  it("change exactly one consonant's sound for soundChange", () => {
    for (const { text, kind } of NAMES) {
      for (const candidate of opCandidates("soundChange", text, kind)) {
        const match = alignPhrase(soundWords(candidate), soundWords(text), {
          prefix: false,
          maxNear: 1,
        });
        expect(match?.near, `${text} → ${candidate}`).toBe(1);
      }
    }
  });

  it("split compounds, join company words, and drop a company's last word, never a person's", () => {
    expect(opCandidates("split", "Glovex Systems", "company")).toEqual(["Glow Vex Systems"]);
    expect(opCandidates("join", "Quarry Lane Media", "company")).toContain("Quarrylane Media");
    expect(opCandidates("join", "Dana Lee", "contact")).toEqual([]);
    expect(opCandidates("dropTail", "Consolidated Parts & Supply", "company")).toEqual([
      "Consolidated Parts",
    ]);
    expect(opCandidates("dropTail", "Dana Lee", "contact")).toEqual([]);
    expect(opCandidates("homophone", "Sean Murphy", "contact").sort()).toEqual([
      "Shaun Murphy",
      "Shawn Murphy",
    ]);
    expect(opCandidates("vowel", "MSC", "company")).toEqual([]);
  });

  it("are all weighted in the stated parameters, and pSnap is a third", () => {
    expect(CHANNEL_PARAMS.biased.pSnap).toBeCloseTo(1 / 3);
    for (const params of [CHANNEL_PARAMS.biased, CHANNEL_PARAMS.unbiased]) {
      for (const [op, weight] of Object.entries(params.ops)) {
        expect(MISHEAR_OPS).toContain(op);
        expect(weight).toBeGreaterThan(0);
      }
    }
    // The biased stream's own mistakes keep the sound: what it gets wrong by sound is the snap.
    expect(CHANNEL_PARAMS.biased.ops.soundChange ?? 0).toBe(0);
  });
});

describe("the witnesses", () => {
  const noFocus = keytermListV1(LINKING_ENTITIES, null);

  it("use the session's keyterms as the web app built them for v1: 100, the open account's first", () => {
    expect(noFocus).toHaveLength(100);
    expect(noFocus.slice(0, 2)).toEqual(["Acme Dynamics", "Acme"]);
    // With no account open, the alphabetically last companies miss AssemblyAI's 100-term cap.
    // The web app no longer drops them (names before aliases, WP8); v1's frozen policy does.
    expect(noFocus).not.toContain("Willowbrook Pharma");
    const lantern = keytermListV1(LINKING_ENTITIES, "co_053");
    expect(lantern.slice(0, 2)).toEqual(["Lantern Hospitality", "Lantern"]);
    expect(lantern).toContain("Katherine Moore");
    expect(lantern).toContain("Lantern Hospitality - Starter plan");
  });

  it("snap the biased reading to an in-list spelling that sounds the same, uniformly", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      seen.add(snapToKeyterms("Kestral Aero", noFocus, createRng(seed)).text);
    }
    expect([...seen].sort()).toEqual(["Kestral Aero", "Kestrel Aero"]);
    expect(snapToKeyterms("Atlis Freight", noFocus, createRng(1)).text).toBe("Atlas Freight");
  });

  it("snap a name a word away only with probability pSnap, and never when told not to", () => {
    expect(snapToKeyterms("Copperline Retail", noFocus, createRng(1), "force")).toEqual({
      text: "Copperleaf Retail",
      ops: ["snap"],
    });
    expect(snapToKeyterms("Copperline Retail", noFocus, createRng(1), "never").ops).toEqual([]);
    let snapped = 0;
    for (let seed = 0; seed < 600; seed++) {
      if (snapToKeyterms("Copperline Retail", noFocus, createRng(seed)).ops.includes("snap")) {
        snapped++;
      }
    }
    expect(snapped / 600).toBeGreaterThan(0.27);
    expect(snapped / 600).toBeLessThan(0.4);
  });

  it("never snap the unbiased reading", () => {
    for (let seed = 0; seed < 300; seed++) {
      const heard = hearUnbiased("Copperline Retail", "company", createRng(seed));
      expect(heard.text).not.toBe("Copperleaf Retail");
      expect(heard.ops.some((op) => op.startsWith("snap"))).toBe(false);
    }
  });

  it("hear the same thing from the same seed", () => {
    const once = hearBiased("Zoey Park", "contact", noFocus, createRng(99), { mishear: "always" });
    const again = hearBiased("Zoey Park", "contact", noFocus, createRng(99), { mishear: "always" });
    expect(again).toEqual(once);
    expect(once.ops.length).toBeGreaterThan(0);
  });
});
