import { describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_KEYTERM_LIMITS,
  DEEPGRAM_KEYTERM_LIMITS,
  estimateKeytermTokens,
  normalizeKeyterm,
  prepareKeyterms,
} from "../src/stt/keyterms";

const terms = (count: number, prefix = "Term") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}`);

describe("AssemblyAI's limits: 100 terms, 50 characters each", () => {
  it("cuts a long list to its first 100 terms", () => {
    const plan = prepareKeyterms(terms(150), ASSEMBLYAI_KEYTERM_LIMITS);
    expect(plan.terms).toHaveLength(100);
    expect(plan.terms[0]).toBe("Term 0");
    expect(plan.terms.at(-1)).toBe("Term 99");
    expect(plan.dropped.overCount).toBe(50);
  });

  it("drops a term over 50 characters rather than cutting it", () => {
    const long = "A".repeat(51);
    const exactly = "B".repeat(50);
    const plan = prepareKeyterms(["Acme", long, exactly], ASSEMBLYAI_KEYTERM_LIMITS);
    expect(plan.terms).toEqual(["Acme", exactly]);
    expect(plan.dropped.tooLong).toBe(1);
  });

  it("lets a dropped term free a place for the next", () => {
    const plan = prepareKeyterms(["X".repeat(60), ...terms(100)], ASSEMBLYAI_KEYTERM_LIMITS);
    expect(plan.terms).toHaveLength(100);
    expect(plan.terms.at(-1)).toBe("Term 99");
  });
});

describe("Deepgram's limits: 50 terms (our cap) within a 500-token estimate", () => {
  it("cuts to 50 terms", () => {
    const plan = prepareKeyterms(terms(80, "Co"), DEEPGRAM_KEYTERM_LIMITS);
    expect(plan.terms).toHaveLength(50);
    expect(plan.dropped.overCount).toBe(30);
  });

  it("stops adding terms that would pass the token budget", () => {
    const names = Array.from(
      { length: 40 },
      (_, i) => `Northwindtraders Internationalization ${i}`,
    );
    const plan = prepareKeyterms(names, DEEPGRAM_KEYTERM_LIMITS);
    const tokens = plan.terms.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
    expect(tokens).toBeLessThanOrEqual(500);
    expect(plan.terms.length).toBeLessThan(40);
    expect(plan.dropped.overTokens).toBe(40 - plan.terms.length);
  });

  it("estimates tokens high: a token per 3 letters, per 2 digits, per symbol, plus one", () => {
    expect(estimateKeytermTokens("Acme")).toBe(1 + 2);
    expect(estimateKeytermTokens("Acme Corp")).toBe(1 + 2 + 2);
    expect(estimateKeytermTokens("Q3-2026")).toBe(1 + 1 + 1 + 1 + 2);
    expect(estimateKeytermTokens("Zoë Kowalczyk")).toBe(1 + 1 + 3);
  });
});

describe("clean-up", () => {
  it("trims, collapses whitespace, strips control characters, and drops blanks", () => {
    expect(normalizeKeyterm("  Acme \t Corp\n")).toBe("Acme Corp");
    expect(normalizeKeyterm("Ac\u0000me")).toBe("Ac me");
    const plan = prepareKeyterms(["", "   ", "Acme"], ASSEMBLYAI_KEYTERM_LIMITS);
    expect(plan.terms).toEqual(["Acme"]);
  });

  it("drops repeats, ignoring case and spacing, keeping the first spelling", () => {
    const plan = prepareKeyterms(
      ["Acme Corp", "acme  corp", "ACME CORP", "Initech"],
      ASSEMBLYAI_KEYTERM_LIMITS,
    );
    expect(plan.terms).toEqual(["Acme Corp", "Initech"]);
    expect(plan.dropped.duplicates).toBe(2);
  });

  it("keeps the caller's ranking", () => {
    const ranked = ["Selected Account", "Its Contact", "Its Deal", "Other Co"];
    expect(prepareKeyterms(ranked, DEEPGRAM_KEYTERM_LIMITS).terms).toEqual(ranked);
  });
});
