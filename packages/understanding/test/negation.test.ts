// Negation (spec WP7 step 3): NegEx-style triggers, a scope of up to 6 words, terminators, and
// pseudo-triggers, on sentences from the debrief scripts and around them.
import { describe, expect, it } from "vitest";
import { isNegated, MAX_SCOPE_TOKENS, negationAt, negationScopes } from "../src/normalize";

/** Each scope as [trigger, the words it negates]. */
function scopes(text: string): [string, string][] {
  return negationScopes(text).map((scope) => [
    scope.trigger,
    text.slice(scope.scopeSpan[0], scope.scopeSpan[1]),
  ]);
}

/** Whether a quote, found in the text, sits inside a negation scope. */
function negated(text: string, quote: string): boolean {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`"${quote}" isn't in "${text}"`);
  return isNegated(text, [start, start + quote.length]);
}

// d007, turn 3.
const D007 = "Not Pacific Crest. They're a separate account, and I'm not touching that deal today.";

describe("the negation in d007", () => {
  it("negates Pacific Crest, and the deal, but not the separate account", () => {
    expect(scopes(D007)).toEqual([
      ["Not", "Pacific Crest"],
      ["not", "touching that deal today"],
    ]);
    expect(negated(D007, "Pacific Crest")).toBe(true);
    expect(negated(D007, "Not Pacific Crest")).toBe(true);
    expect(negated(D007, "that deal today")).toBe(true);
    expect(negated(D007, "a separate account")).toBe(false);
    expect(negationAt(D007, [4, 17])?.trigger).toBe("Not");
  });
});

describe("triggers", () => {
  it("knows the spec's triggers and the rest of the n't family", () => {
    for (const [text, trigger] of [
      ["They won't renew the contract.", "won't"],
      ["We don't need the add-on.", "don't"],
      ["She can't sign this quarter.", "can't"],
      ["It isn't in the budget.", "isn't"],
      ["Procurement hasn't signed yet.", "hasn't"],
      ["I didn't talk to Kestral Aero this week.", "didn't"],
      ["They never answered the email.", "never"],
      ["No update there.", "No"],
      ["Nothing changes for Glovex.", "Nothing"],
      ["Ship it without the warranty.", "without"],
      ["They dont want the pilot.", "dont"],
    ] as const) {
      expect(scopes(text)[0]?.[0], text).toBe(trigger);
    }
  });

  it("starts the scope after a longer trigger: no longer, not going to", () => {
    expect(scopes("They're not going to renew the contract with Acme this year.")).toEqual([
      ["not going to", "renew the contract with Acme this"],
    ]);
    expect(scopes("Raj no longer runs procurement.")).toEqual([["no longer", "runs procurement"]]);
  });

  it("ignores the pseudo-triggers", () => {
    expect(scopes("No problem, we'll send the quote Friday.")).toEqual([]);
    expect(scopes("No doubt they'll sign the renewal.")).toEqual([]);
    expect(scopes("Not only the software but the hardware too.")).toEqual([]);
    expect(scopes("Tuesday, no wait, Wednesday.")).toEqual([]);
    expect(scopes("Tuesday no wait Wednesday")).toEqual([]);
    // A pseudo-trigger doesn't hide a real one later on.
    expect(scopes("No problem, but they won't pay for it.")).toEqual([["won't", "pay for it"]]);
  });
});

describe("the scope", () => {
  it(`runs at most ${MAX_SCOPE_TOKENS} words`, () => {
    // d003: "Atmas Group" is the 5th and 6th word after "Not".
    const d003 = "Not to be confused with Atmas Group, which is a different account.";
    expect(scopes(d003)).toEqual([["Not", "to be confused with Atmas Group"]]);
    expect(negated(d003, "Atmas Group")).toBe(true);
    // d005: the 7th word is out of reach.
    const d005 = "Don't mix them up with Northwind Labs or Northwind Foods.";
    expect(negated(d005, "Northwind Labs")).toBe(true);
    expect(negated(d005, "Northwind Foods")).toBe(false);
  });

  it("ends at clause punctuation and at the terminators", () => {
    // d026: the deal stage comes after the comma.
    const d026 =
      "Bad news from Granite State Builders. They're not going ahead with the analytics add-on this year, so mark it closed lost.";
    expect(negated(d026, "closed lost")).toBe(false);
    expect(negated(d026, "They're not going ahead with the analytics add-on this year")).toBe(true);
    expect(scopes("They won't sign but they will pilot it.")).toEqual([["won't", "sign"]]);
    expect(scopes("Not the hardware; the software ships.")).toEqual([["Not", "the hardware"]]);
    for (const terminator of ["however", "although", "though", "except", "still"]) {
      expect(scopes(`They won't sign ${terminator} they like it.`)).toEqual([["won't", "sign"]]);
    }
  });

  it("gives a trigger with nothing after it no scope", () => {
    expect(scopes("No, they signed.")).toEqual([]);
    expect(negated("No, they signed.", "they signed")).toBe(false);
  });

  it("leaves what comes before a trigger alone", () => {
    // d006: the task's quote comes before "won't".
    const d006 =
      "Jeffrey Walsh wants a quote for sixty units, and Meridian won't consider anything without a two-year warranty.";
    expect(negated(d006, "a quote for sixty units")).toBe(false);
    expect(negated(d006, "Meridian")).toBe(false);
    expect(negated(d006, "a two-year warranty")).toBe(true);
    // d009: the deal's amount sits in the next sentence.
    const d009 =
      "Summit Ridge Medical, not Summit Ridge Capital. Their CFO, Yara Yilmaz, approved the starter plan at twenty-two thousand.";
    expect(negated(d009, "Summit Ridge Capital")).toBe(true);
    expect(negated(d009, "Summit Ridge Medical")).toBe(false);
    expect(negated(d009, "twenty-two thousand")).toBe(false);
  });

  it("reads curly apostrophes as straight ones", () => {
    expect(scopes("They won’t renew.")).toEqual([["won’t", "renew"]]);
  });
});
