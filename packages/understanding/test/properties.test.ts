// Property tests: symmetry, bounds, and idempotence over seeded random inputs (hand-rolled, as the
// repo has no property-testing library). Each property runs on the same inputs every time.
import { describe, expect, it } from "vitest";
import {
  alignTokens,
  editDistance,
  foldName,
  initials,
  jaroWinkler,
  normalizedEditDistance,
  normalizeName,
  phoneticDistance,
  phoneticKeys,
  similarity,
  trigrams,
  wordCost,
  wordSimilarity,
} from "../src/names";
import { mulberry32, mutateName, type Random, randomName, randomText } from "./support/random";

const RUNS = 400;

/** Pairs of related and unrelated strings: names, their mishearings, and arbitrary text. */
function pairs(seed: number): [string, string][] {
  const random = mulberry32(seed);
  return Array.from({ length: RUNS }, (_, n) => {
    if (n % 3 === 0) return [randomText(random), randomText(random)];
    const name = randomName(random);
    return [name, n % 3 === 1 ? mutateName(random, name) : randomName(random)];
  });
}

function inUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

const FOLDED = /^(?:[\p{L}\p{M}\p{N}]+(?: [\p{L}\p{M}\p{N}]+)*)?$/u;

describe("symmetry and bounds", () => {
  it("similarity is symmetric, in [0, 1], and 1 against itself", () => {
    for (const [a, b] of pairs(1)) {
      const score = similarity(a, b);
      expect(inUnitInterval(score), `${a} ~ ${b}`).toBe(true);
      expect(similarity(b, a), `${a} ~ ${b}`).toBe(score);
      expect(similarity(a, a), a).toBe(trigrams(a).length > 0 ? 1 : 0);
    }
  });

  it("word_similarity is in [0, 1] both ways, and 1 against itself", () => {
    for (const [a, b] of pairs(2)) {
      expect(inUnitInterval(wordSimilarity(a, b)), `${a} ~ ${b}`).toBe(true);
      expect(inUnitInterval(wordSimilarity(b, a)), `${b} ~ ${a}`).toBe(true);
      expect(wordSimilarity(a, a), a).toBe(trigrams(a).length > 0 ? 1 : 0);
    }
  });

  it("Jaro-Winkler is symmetric, in [0, 1], and 1 against itself", () => {
    for (const [raw, rawOther] of pairs(3)) {
      const [a, b] = [normalizeName(raw), normalizeName(rawOther)];
      const score = jaroWinkler(a, b);
      expect(inUnitInterval(score), `${a} ~ ${b}`).toBe(true);
      expect(jaroWinkler(b, a), `${a} ~ ${b}`).toBe(score);
      expect(jaroWinkler(a, a)).toBe(1);
    }
  });

  it("edit distance is a metric bounded by the longer length", () => {
    const random = mulberry32(4);
    for (const [a, b] of pairs(4)) {
      const c = randomText(random);
      const d = editDistance(a, b);
      const [la, lb] = [Array.from(a).length, Array.from(b).length];
      expect(editDistance(b, a)).toBe(d);
      expect(d).toBeGreaterThanOrEqual(Math.abs(la - lb));
      expect(d).toBeLessThanOrEqual(Math.max(la, lb));
      expect(d === 0).toBe(a === b);
      expect(d).toBeLessThanOrEqual(editDistance(a, c) + editDistance(c, b));
      expect(inUnitInterval(normalizedEditDistance(a, b))).toBe(true);
    }
  });

  it("phonetic distance is symmetric, in [0, 1], and 0 against itself", () => {
    for (const [a, b] of pairs(5)) {
      const distance = phoneticDistance(a, b);
      expect(inUnitInterval(distance), `${a} ~ ${b}`).toBe(true);
      expect(phoneticDistance(b, a), `${a} ~ ${b}`).toBe(distance);
      expect(phoneticDistance(a, a)).toBe(0);
    }
  });

  it("word cost is symmetric, in [0, 1], and 0 against itself", () => {
    for (const [a, b] of pairs(6)) {
      const cost = wordCost(a, b);
      expect(inUnitInterval(cost), `${a} ~ ${b}`).toBe(true);
      expect(wordCost(b, a), `${a} ~ ${b}`).toBe(cost);
      expect(wordCost(a, a)).toBe(0);
    }
  });
});

describe("token alignment", () => {
  /** A transcript and a second hearing of it: words misheard, dropped, added, split, or joined. */
  function hearings(random: Random): [string[], string[]] {
    const first = Array.from({ length: 1 + Math.floor(random() * 8) }, () => randomName(random))
      .join(" ")
      .split(" ");
    return [first, mutateName(random, first.join(" ")).split(" ").filter(Boolean)];
  }

  it("covers every word of both sides once, in order, at a symmetric cost", () => {
    const random = mulberry32(7);
    for (let n = 0; n < RUNS / 2; n++) {
      const [a, b] = hearings(random);
      const alignment = alignTokens(a, b);
      const label = `${a.join(" ")} | ${b.join(" ")}`;
      expect(
        alignment.steps.flatMap((step) => step.a),
        label,
      ).toEqual(a.map((_, i) => i));
      expect(
        alignment.steps.flatMap((step) => step.b),
        label,
      ).toEqual(b.map((_, j) => j));
      for (const step of alignment.steps) {
        expect(step.a.length + step.b.length).toBeGreaterThan(0);
        expect(step.a.length <= 2 && step.b.length <= 2).toBe(true);
        expect(step.cost).toBeGreaterThanOrEqual(0);
      }
      const sum = alignment.steps.reduce((total, step) => total + step.cost, 0);
      expect(alignment.cost).toBeCloseTo(sum, 9);
      expect(alignTokens(b, a).cost, label).toBe(alignment.cost);
      expect(alignTokens(a, a).cost).toBe(0);
    }
  });
});

describe("normalization and keys", () => {
  it("folding and normalizing are idempotent, and yield single-spaced lowercase words", () => {
    for (const [a] of pairs(8)) {
      const folded = foldName(a);
      expect(foldName(folded), a).toBe(folded);
      expect(normalizeName(normalizeName(a)), a).toBe(normalizeName(a));
      expect(FOLDED.test(folded), a).toBe(true);
      expect(folded).toBe(folded.toLowerCase());
    }
  });

  it("initials are one letter per word at most, with no spaces", () => {
    for (const [a] of pairs(9)) {
      const folded = foldName(a);
      const words = folded === "" ? 0 : folded.split(" ").length;
      expect(Array.from(initials(a)).length).toBeLessThanOrEqual(words);
      expect(initials(a)).not.toContain(" ");
    }
  });

  it("keys are sorted and unique, and a record's keys include each of its names' keys", () => {
    for (const [a, b] of pairs(10)) {
      const keys = phoneticKeys([a, b]);
      expect(keys).toEqual([...new Set(keys)].sort());
      expect(keys.every((key) => /^[A-Z0]+$/.test(key))).toBe(true);
      for (const key of phoneticKeys(a)) expect(keys).toContain(key);
      expect(phoneticKeys([b, a])).toEqual(keys);
    }
  });
});
