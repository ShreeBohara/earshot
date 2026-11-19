import { describe, expect, it } from "vitest";
import { type FieldRiskInput, fieldRiskFlags } from "../src/risk";

function flags(input: Partial<FieldRiskInput> & Pick<FieldRiskInput, "spanText">) {
  return fieldRiskFlags({
    field: "body",
    value: input.spanText,
    before: "",
    confidence: 0.95,
    ...input,
  }).map((flag) => flag.kind);
}

describe("fieldRiskFlags", () => {
  it("flags a date field, whatever its quote says", () => {
    expect(flags({ field: "dueDate", value: "2026-11-12", spanText: "by Thursday" })).toEqual([
      "date",
    ]);
    expect(flags({ field: "closeDate", value: "2026-12-31", spanText: "soon" })).toEqual(["date"]);
  });

  it("flags a quote that names a day, a month, or a relative date", () => {
    for (const spanText of [
      "by Thursday",
      "early December",
      "on May 5th",
      "the 3rd of May",
      "before Nov 20",
      "tomorrow",
      "next week",
      "by the end of the quarter",
      "in Q3",
      "in two weeks",
      "on 11/20",
      "by the 12th",
    ]) {
      expect(flags({ spanText }), spanText).toContain("date");
    }
  });

  it("doesn't take 'may' the verb for the month", () => {
    expect(flags({ spanText: "we may run a workshop" })).toEqual([]);
  });

  it("flags numbers: a numeric value, digits, or number words, but not a date's digits twice", () => {
    expect(flags({ field: "amount", value: 80000, spanText: "eighty grand" })).toEqual(["number"]);
    expect(flags({ spanText: "20 seats" })).toEqual(["number"]);
    expect(flags({ spanText: "fifty thousand dollars" })).toEqual(["number"]);
    expect(flags({ field: "dueDate", value: "2026-11-20", spanText: "on 11/20" })).toEqual([
      "date",
    ]);
    expect(flags({ spanText: "one of their engineers" })).toEqual([]);
  });

  it("flags a negation in the quote, or in the words just before it", () => {
    expect(flags({ spanText: "won’t renew this year" })).toContain("negation");
    expect(flags({ spanText: "they never signed" })).toContain("negation");
    expect(flags({ spanText: "renew the contract", before: "they will not" })).toContain(
      "negation",
    );
    expect(flags({ spanText: "renew the contract", before: "they will gladly" })).toEqual([]);
    expect(flags({ spanText: "send the notes" })).toEqual([]); // "notes" isn't "not"
  });

  it("flags evidence below the confidence threshold", () => {
    expect(flags({ spanText: "Dana Lee", confidence: 0.69 })).toEqual(["low_confidence"]);
    expect(flags({ spanText: "Dana Lee", confidence: 0.7 })).toEqual([]);
  });

  it("names the field on every flag, in a fixed order", () => {
    expect(
      fieldRiskFlags({
        field: "dueDate",
        value: "2026-11-12",
        spanText: "not by Thursday",
        before: "",
        confidence: 0.5,
      }),
    ).toEqual([
      { kind: "date", field: "dueDate" },
      { kind: "negation", field: "dueDate" },
      { kind: "low_confidence", field: "dueDate" },
    ]);
  });
});
