import { describe, expect, it } from "vitest";
import {
  alignedRange,
  alignTokens,
  codeDistance,
  editDistance,
  foldName,
  initials,
  isInitialsOf,
  isLegalSuffix,
  jaro,
  jaroWinkler,
  joinedCodes,
  joinSpelledLetters,
  MERGE_PENALTY,
  nameCodes,
  nameTokens,
  normalizedEditDistance,
  normalizeName,
  phoneticDistance,
  phoneticKeys,
  sameSound,
  similarity,
  trigramSimilarity,
  trigrams,
  wordCodes,
  wordCost,
  wordSimilarity,
} from "../src/names";
import { MEASURED_PAIRS } from "../src/testing";

describe("normalizeName", () => {
  it("folds case, punctuation, '&', and spaces, and drops a legal-form suffix", () => {
    expect(foldName("Maple & Vine Grocers, Inc.")).toBe("maple and vine grocers inc");
    expect(normalizeName("Maple & Vine Grocers, Inc.")).toBe("maple and vine grocers");
    expect(normalizeName("  Acme   Dynamics  ")).toBe("acme dynamics");
    expect(normalizeName("Harborview Health - Multi-year agreement")).toBe(
      "harborview health multi year agreement",
    );
  });

  it("drops legal-form suffixes only at the end, and never empties a name", () => {
    expect(normalizeName("Midland Steel Corp")).toBe("midland steel");
    expect(normalizeName("Meridian Supply Co")).toBe("meridian supply");
    expect(normalizeName("Acme L.L.C.")).toBe("acme");
    expect(normalizeName("Smith & Co. Ltd")).toBe("smith");
    expect(normalizeName("Co Op Foods")).toBe("co op foods");
    expect(normalizeName("Corp")).toBe("corp");
    expect(isLegalSuffix("llc")).toBe(true);
    expect(isLegalSuffix("group")).toBe(false);
  });

  it("joins across apostrophes and periods, and splits on every other mark", () => {
    expect(normalizeName("O'Brien’s Pier")).toBe("obriens pier");
    expect(normalizeName("A.C.M.E.")).toBe("acme");
    expect(normalizeName("Jean-Luc / Partners")).toBe("jean luc partners");
  });

  it("applies NFKC and full case folding, and keeps diacritics", () => {
    expect(normalizeName("ＡＣＭＥ ﬁnch")).toBe("acme finch");
    expect(normalizeName("STRAẞE")).toBe("strasse");
    expect(normalizeName("Straße")).toBe("strasse");
    expect(normalizeName("José Müller")).toBe("josé müller");
  });

  it("gives no tokens for a name without letters or numbers, and reads '&' as a word", () => {
    expect(nameTokens("")).toEqual([]);
    expect(nameTokens(" -- / ")).toEqual([]);
    expect(nameTokens(" -- & ")).toEqual(["and"]);
  });
});

describe("Double Metaphone keys", () => {
  it("gives the measured sound-alikes a shared code (Appendix A)", () => {
    expect(wordCodes("Nite")).toEqual({ primary: "NT", alternate: "NT" });
    expect(wordCodes("Knight")).toEqual({ primary: "NT", alternate: "NT" });
    expect(sameSound(wordCodes("Akme"), wordCodes("Acme"))).toBe(true);
    // "Pier" is P/PR: they meet on the alternate.
    expect(wordCodes("Pier")).toEqual({ primary: "P", alternate: "PR" });
    expect(sameSound(wordCodes("Peer"), wordCodes("Pier"))).toBe(true);
    expect(sameSound(joinedCodes("Dana Li"), joinedCodes("Dana Lee"))).toBe(true);
  });

  it("keeps the measured near-homophones apart", () => {
    expect(joinedCodes("Atmas").primary).toBe("ATMS");
    expect(joinedCodes("Atlas").primary).toBe("ATLS");
    expect(sameSound(joinedCodes("Atmas"), joinedCodes("Atlas"))).toBe(false);
    expect(sameSound(joinedCodes("Glovex"), joinedCodes("Globelex"))).toBe(false);
    // A limit of the algorithm, not of the port: Sean is SN, Shawn and Shaun are XN. The linker
    // has spelling and context for that group.
    expect(sameSound(wordCodes("Sean"), wordCodes("Shawn"))).toBe(false);
    expect(sameSound(wordCodes("Shawn"), wordCodes("Shaun"))).toBe(true);
  });

  it("returns full-length codes that extend Postgres's 4-character dmetaphone", () => {
    expect(wordCodes("acceptingness").primary).toBe("AKSPTNNS");
    expect(joinedCodes("Northwind")).toEqual({ primary: "NR0NT", alternate: "NRTNT" });
    for (const pair of MEASURED_PAIRS) {
      for (const [name, measured] of [
        [pair.left, pair.dmetaphone[0]],
        [pair.right, pair.dmetaphone[1]],
      ] as const) {
        const [primary, alternate] = measured.split("/");
        const codes = joinedCodes(name);
        expect(codes.primary.slice(0, 4), name).toBe(primary);
        if (alternate) expect(codes.alternate.slice(0, 4), name).toBe(alternate);
      }
    }
  });

  it("encodes a name's significant tokens: no legal suffix, no connectors", () => {
    expect(nameCodes("Maple & Vine Grocers").map((token) => token.token)).toEqual([
      "maple",
      "vine",
      "grocers",
    ]);
    expect(nameCodes("Midland Steel Corp").map((token) => token.token)).toEqual([
      "midland",
      "steel",
    ]);
    expect(joinedCodes("Atmas Group").primary).toBe("ATMSKRP");
  });

  it("encodes a transcript word whole, folding it first", () => {
    expect(wordCodes("Knight's")).toEqual(wordCodes("knights"));
    expect(wordCodes("AT&T")).toEqual({ primary: "ATANTT", alternate: "ATANTT" });
    expect(wordCodes("Co")).toEqual({ primary: "K", alternate: "K" });
  });

  it("makes sorted, unique keys for a record's name and aliases", () => {
    expect(phoneticKeys(["Knight Security", "Knight"])).toEqual(["NT", "SKRT"]);
    expect(phoneticKeys(["Pier Logistics", "Pier"])).toEqual(["LJSTKS", "LKSTKS", "P", "PR"]);
    expect(phoneticKeys("Meridian Supply Co")).toEqual(["MRTN", "SPL"]);
    expect(phoneticKeys(["Meridian Supply Co", "Meridian", "MSC"])).toEqual(["MRTN", "MSK", "SPL"]);
    // Records that sound alike share a key, which is what an overlap query finds.
    const knight = new Set(phoneticKeys("Knight Security"));
    expect(phoneticKeys("Nite Security Group").filter((key) => knight.has(key))).toEqual([
      "NT",
      "SKRT",
    ]);
    expect(phoneticKeys(["123", "h"])).toEqual([]);
    expect(phoneticKeys([])).toEqual([]);
  });

  it("measures how differently two names sound", () => {
    expect(phoneticDistance("Atmas", "Atlas")).toBe(0.25);
    expect(phoneticDistance("Nite", "Knight")).toBe(0);
    expect(phoneticDistance("Peer", "Pier")).toBe(0);
    expect(codeDistance({ primary: "", alternate: "" }, { primary: "", alternate: "" })).toBe(0);
    expect(
      codeDistance({ primary: "ATMS", alternate: "ATMS" }, { primary: "", alternate: "" }),
    ).toBe(1);
  });
});

describe("pg_trgm similarity and word_similarity", () => {
  it("matches every pair measured on PGlite (Appendix A)", () => {
    for (const pair of MEASURED_PAIRS) {
      const label = `${pair.left} ~ ${pair.right}`;
      expect(similarity(pair.left, pair.right), label).toBeCloseTo(pair.similarity, 3);
      expect(wordSimilarity(pair.left, pair.right), label).toBeCloseTo(pair.wordSimilarity, 3);
    }
  });

  it("pads each lowercased word with two spaces before and one after", () => {
    expect(trigrams("Acme")).toEqual(["  a", " ac", "acm", "cme", "me "]);
    expect(trigrams("a")).toEqual(["  a", " a "]);
    expect(trigrams("Acme, Inc.")).toEqual(trigrams("acme inc"));
    // Underscores aren't word characters (checked on PGlite).
    expect(trigrams("abc_def")).toEqual(trigrams("abc def"));
    expect(trigrams("")).toEqual([]);
    expect(trigrams("!?")).toEqual([]);
  });

  it("scores 0 when either side has no trigrams", () => {
    expect(similarity("", "")).toBe(0);
    expect(similarity("!!!", "abc")).toBe(0);
    expect(wordSimilarity("", "abc")).toBe(0);
    expect(wordSimilarity("abc", "")).toBe(0);
  });

  it("matches PGlite's word_similarity on repeats and short words, which it isn't symmetric on", () => {
    expect(wordSimilarity("Northwind", "Northwind Logistics")).toBe(1);
    expect(wordSimilarity("Northwind Logistics", "Northwind")).toBe(0.5);
    // Values PGlite returned for these pairs.
    expect(similarity("abc abc abd", "abd")).toBeCloseTo(0.6666667, 6);
    expect(wordSimilarity("abc abc abd", "abd")).toBeCloseTo(0.6666667, 6);
    expect(similarity("x", "xyz")).toBeCloseTo(0.2, 6);
    expect(wordSimilarity("x", "xyz")).toBeCloseTo(0.5, 6);
    expect(similarity("café", "cafe")).toBeCloseTo(0.42857143, 6);
    expect(wordSimilarity("café", "cafe")).toBeCloseTo(0.6, 6);
  });

  it("scores precomputed trigram sets as it scores the strings", () => {
    expect(trigramSimilarity(trigrams("Akme Dynamics"), trigrams("Acme Dynamics"))).toBe(
      similarity("Akme Dynamics", "Acme Dynamics"),
    );
  });
});

describe("Jaro-Winkler", () => {
  it("gives the textbook values", () => {
    expect(jaro("martha", "marhta")).toBeCloseTo(0.944444, 6);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961111, 6);
    expect(jaro("dixon", "dicksonx")).toBeCloseTo(0.766667, 6);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.813333, 6);
    expect(jaroWinkler("jellyfish", "smellyfish")).toBeCloseTo(0.896296, 6);
    expect(jaroWinkler("kestral", "kestrel")).toBeCloseTo(0.942857, 6);
  });

  it("adds the prefix bonus only above 0.7", () => {
    expect(jaro("abcd", "abzz")).toBeCloseTo(2 / 3, 9);
    expect(jaroWinkler("abcd", "abzz")).toBe(jaro("abcd", "abzz"));
  });

  it("handles empty and disjoint strings", () => {
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("abc", "")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
});

describe("edit distance on codes", () => {
  it("counts insertions, deletions, and substitutions", () => {
    expect(editDistance("ATMS", "ATLS")).toBe(1);
    expect(editDistance("KLFKS", "KLPLKS")).toBe(2);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    // Code points, not UTF-16 units.
    expect(editDistance("𝒜b", "ab")).toBe(1);
  });

  it("normalizes by the longer length", () => {
    expect(normalizedEditDistance("ATMS", "ATLS")).toBe(0.25);
    expect(normalizedEditDistance("", "")).toBe(0);
    expect(normalizedEditDistance("A", "")).toBe(1);
  });
});

describe("initials", () => {
  it("takes the first letter of each word, legal suffixes included", () => {
    expect(initials("Meridian Supply Co")).toBe("msc");
    expect(initials("Midland Steel Corp")).toBe("msc");
    expect(initials("Consolidated Parts & Supply")).toBe("cps");
    expect(initials("Bay Harbor Associates")).toBe("bha");
    expect(initials("Acme")).toBe("a");
    expect(initials("")).toBe("");
  });

  it("joins letters spelled out one by one", () => {
    expect(joinSpelledLetters("M.S.C.")).toBe("msc");
    expect(joinSpelledLetters("M. S. C.")).toBe("msc");
    expect(joinSpelledLetters("A C M E Corp")).toBe("acme corp");
    expect(joinSpelledLetters("Dana J Lee")).toBe("dana j lee");
  });

  it("recognizes a mention made of a name's initials", () => {
    expect(isInitialsOf("MSC", "Meridian Supply Co")).toBe(true);
    expect(isInitialsOf("M S C", "Midland Steel Corp")).toBe(true);
    expect(isInitialsOf("MS", "Midland Steel Corp")).toBe(true);
    expect(isInitialsOf("BHA", "Blue Harbor Analytics")).toBe(true);
    expect(isInitialsOf("cps", "Consolidated Parts & Supply")).toBe(true);
    expect(isInitialsOf("A", "Acme")).toBe(false);
    expect(isInitialsOf("Acme", "Acme Dynamics")).toBe(false);
    expect(isInitialsOf("MSC Group", "Meridian Supply Co")).toBe(false);
  });
});

describe("token alignment", () => {
  const words = (text: string) => text.split(" ");

  it("costs nothing for the same words, whatever their case or punctuation", () => {
    const alignment = alignTokens(words("Call Acme, today."), words("call acme today"));
    expect(alignment.cost).toBe(0);
    expect(alignment.steps.map((step) => [step.a, step.b])).toEqual([
      [[0], [0]],
      [[1], [1]],
      [[2], [2]],
    ]);
  });

  it("prices a substitution by sound and spelling", () => {
    expect(wordCost("Acme", "acme,")).toBe(0);
    expect(wordCost("Nite", "Knight")).toBe(0.2);
    expect(wordCost("Lee", "Li")).toBe(0.2);
    expect(wordCost("Atmos", "Atmo")).toBeCloseTo(0.36, 9);
    expect(wordCost("industrial", "systems")).toBeGreaterThan(0.5);
    expect(wordCost("Atmos", "")).toBe(1);
  });

  it("finds what the other transcript heard where the mention is", () => {
    const biased = words("we met Atmos Industrial today");
    const unbiased = words("we met Atmo Systems today");
    const alignment = alignTokens(biased, unbiased);
    expect(alignedRange(alignment, 2, 4)).toEqual({ start: 2, end: 4 });
  });

  it("aligns one word heard as two, and two as one", () => {
    const split = alignTokens(words("the Glovex deal"), words("the glow vex deal"));
    expect(split.steps.map((step) => [step.a, step.b])).toEqual([
      [[0], [0]],
      [[1], [1, 2]],
      [[2], [3]],
    ]);
    expect(alignedRange(split, 1, 2)).toEqual({ start: 1, end: 3 });

    const joined = alignTokens(words("glow vex"), words("Glovex"));
    expect(joined.steps.map((step) => [step.a, step.b])).toEqual([[[0, 1], [0]]]);
    expect(joined.cost).toBeCloseTo(MERGE_PENALTY + 0.2, 9);
  });

  it("leaves a filler out of the range, and gives null where the other side heard nothing", () => {
    // Not a split of "Acme" into "uh Acme", however long the word.
    const filler = alignTokens(words("Acme Dynamics"), words("uh Acme Dynamics"));
    expect(filler.steps[0]).toEqual({ a: [], b: [0], cost: 1 });
    expect(alignedRange(filler, 0, 2)).toEqual({ start: 1, end: 3 });
    const long = alignTokens(words("Consolidated Parts"), words("um Consolidated Parts"));
    expect(long.steps.map((step) => [step.a, step.b])).toEqual([
      [[], [0]],
      [[0], [1]],
      [[1], [2]],
    ]);

    const dropped = alignTokens(words("call Atmos now"), words("call now"));
    expect(alignedRange(dropped, 1, 2)).toBeNull();
  });

  it("handles empty sequences", () => {
    expect(alignTokens([], [])).toEqual({ steps: [], cost: 0 });
    expect(alignTokens(["Acme"], [])).toEqual({ steps: [{ a: [0], b: [], cost: 1 }], cost: 1 });
    expect(alignTokens([], ["Acme"])).toEqual({ steps: [{ a: [], b: [0], cost: 1 }], cost: 1 });
  });
});
