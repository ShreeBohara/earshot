// The faithfulness check (spec WP7 step 5): each field type's check, decision 12's replacement,
// corrections before readings, and the negation flag.
import { describe, expect, it } from "vitest";
import {
  type CheckContext,
  checkField,
  contentWordOverlap,
  type FieldKind,
  type FieldValue,
  fieldKind,
  normalizeEmail,
  normalizePhone,
} from "../src/faithfulness";

// Friday 2026-12-04, 14:00 in New York.
const CONTEXT: CheckContext = {
  turnText: "",
  callTime: "2026-12-04T19:00:00.000Z",
  timeZone: "America/New_York",
};

/** Checks a field whose quote is found in the utterance; the turn is the utterance. */
function check(
  kind: FieldKind,
  value: FieldValue,
  utterance: string,
  quote: string,
  context: Partial<CheckContext> = {},
) {
  const start = utterance.indexOf(quote);
  if (start < 0) throw new Error(`"${quote}" isn't in "${utterance}"`);
  return checkField(
    { field: "f", kind, value, utterance, span: [start, start + quote.length] },
    { ...CONTEXT, turnText: utterance, ...context },
  );
}

const kinds = (result: ReturnType<typeof check>) => result.flags.map((flag) => flag.kind);

describe("names, emails, and phones: equal to the quote once normalized", () => {
  it("compares names without case, punctuation, or a legal suffix", () => {
    const said = "Their new controller is erik nilsson, from Acme Dynamics Inc.";
    expect(check("name", "Erik Nilsson", said, "erik nilsson")).toEqual({
      value: "Erik Nilsson",
      flags: [],
      verdict: "supported",
    });
    expect(check("name", "Acme Dynamics", said, "Acme Dynamics Inc").verdict).toBe("supported");
  });

  it("flags a name that isn't the quote, and never replaces it", () => {
    const result = check(
      "name",
      "Eric Nilsson",
      "Their controller is Erik Nilsson.",
      "Erik Nilsson",
    );
    expect(result).toEqual({
      value: "Eric Nilsson",
      flags: [{ kind: "value_mismatch", field: "f" }],
      verdict: "mismatch",
    });
  });

  it("writes out a spoken email address", () => {
    expect(normalizeEmail("Dana dot Lee at Acme dot com.")).toBe("dana.lee@acme.com");
    const said = "Her email is dana dot lee at acme dot com.";
    expect(check("email", "dana.lee@acme.com", said, "dana dot lee at acme dot com").verdict).toBe(
      "supported",
    );
    expect(kinds(check("email", "dana.li@acme.com", said, "dana dot lee at acme dot com"))).toEqual(
      ["value_mismatch"],
    );
  });

  it("compares a phone number's digits, spoken or written", () => {
    expect(normalizePhone("five five five, oh one oh, double four seven seven")).toBe("5550104477");
    const said = "Call him on five five five oh one oh four four seven seven.";
    const quote = "five five five oh one oh four four seven seven";
    expect(check("phone", "(555) 010-4477", said, quote).verdict).toBe("supported");
    expect(check("phone", "+1 555 010 4477", said, quote).verdict).toBe("supported");
    expect(kinds(check("phone", "555-010-4478", said, quote))).toEqual(["value_mismatch"]);
  });
});

describe("dates: the value is among the readings", () => {
  const said = "Send the revised invoice by Monday.";

  it("supports a value that is the reading", () => {
    expect(check("date", "2026-12-07", said, "by Monday")).toEqual({
      value: "2026-12-07",
      flags: [],
      verdict: "supported",
    });
  });

  it("replaces a value that disagrees with a unique reading (decision 12)", () => {
    expect(check("date", "2026-12-14", said, "by Monday")).toEqual({
      value: "2026-12-07",
      norm: { llmValue: "2026-12-14" },
      flags: [{ kind: "value_mismatch", field: "f" }],
      verdict: "replaced",
    });
  });

  it("keeps the model's value for an ambiguous quote, with every reading", () => {
    const next = "Let's book the review for next Friday.";
    expect(check("date", "2026-12-11", next, "next Friday")).toEqual({
      value: "2026-12-11",
      norm: { readings: ["2026-12-11", "2026-12-18"] },
      flags: [{ kind: "ambiguous_value", field: "f" }],
      verdict: "ambiguous",
    });
    expect(check("date", "2026-12-25", next, "next Friday")).toEqual({
      value: "2026-12-25",
      norm: { readings: ["2026-12-11", "2026-12-18"] },
      flags: [
        { kind: "value_mismatch", field: "f" },
        { kind: "ambiguous_value", field: "f" },
      ],
      verdict: "mismatch",
    });
  });

  it("calls a period with no day ambiguous, without guessing its readings", () => {
    const result = check("date", "2026-12-08", "We'll start sometime next week.", "next week");
    expect(result).toEqual({
      value: "2026-12-08",
      flags: [{ kind: "ambiguous_value", field: "f" }],
      verdict: "ambiguous",
    });
  });

  it("flags a date quote with no date in it", () => {
    expect(check("date", "2026-12-07", said, "the revised invoice")).toEqual({
      value: "2026-12-07",
      flags: [{ kind: "unsupported", field: "f" }],
      verdict: "unread",
    });
  });
});

describe("times: a meeting's time against its readings", () => {
  it("replaces a wrong time and keeps an ambiguous one", () => {
    const said = "Book the demo for 3pm on Thursday.";
    expect(check("time", "15:00", said, "3pm").verdict).toBe("supported");
    expect(check("time", "3:00", said, "3pm")).toMatchObject({
      value: "15:00",
      norm: { llmValue: "3:00" },
      verdict: "replaced",
    });
    expect(check("time", "15:00", "Book the demo at 3 on Thursday.", "at 3")).toMatchObject({
      norm: { readings: ["15:00", "03:00"] },
      verdict: "ambiguous",
    });
  });

  it("flags a time on a day the clocks change", () => {
    const said = "Book the call for 10am on Sunday.";
    const context = { timeZone: "America/Chicago", callTime: "2026-10-29T15:00:00.000Z" };
    expect(kinds(check("time", "10:00", said, "10am", { ...context, date: "2026-11-01" }))).toEqual(
      ["ambiguous_value"],
    );
    expect(kinds(check("time", "10:00", said, "10am", { ...context, date: "2026-11-08" }))).toEqual(
      [],
    );
  });
});

describe("amounts: the value equals the parsed amount", () => {
  const said = "They approved the starter plan at twenty-two thousand.";

  it("supports the parsed amount, from a number or a numeric string", () => {
    expect(check("amount", 22_000, said, "twenty-two thousand")).toEqual({
      value: 22_000,
      flags: [],
      verdict: "supported",
    });
    expect(check("amount", "22,000", said, "twenty-two thousand").value).toBe(22_000);
  });

  it("replaces a wrong amount with the parsed one", () => {
    expect(check("amount", 2_200, said, "twenty-two thousand")).toEqual({
      value: 22_000,
      norm: { llmValue: 2_200 },
      flags: [{ kind: "value_mismatch", field: "f" }],
      verdict: "replaced",
    });
  });

  it("records the currency the words name", () => {
    const dollars = "Close it at forty-two thousand dollars.";
    expect(check("amount", 42_000, dollars, "forty-two thousand dollars")).toEqual({
      value: 42_000,
      norm: { currency: "USD" },
      flags: [],
      verdict: "supported",
    });
  });

  it("flags a currency the field isn't kept in, without converting", () => {
    const euros = "They signed at forty thousand euros.";
    expect(check("amount", 40_000, euros, "forty thousand euros")).toEqual({
      value: 40_000,
      norm: { currency: "EUR" },
      flags: [{ kind: "value_mismatch", field: "f" }],
      verdict: "mismatch",
    });
    expect(
      check("amount", 40_000, euros, "forty thousand euros", { currency: "EUR" }).verdict,
    ).toBe("supported");
  });

  it("keeps the model's value for a range, with both readings", () => {
    const range = "Budget is somewhere around 50 to 60k for the pilot.";
    expect(check("amount", 60_000, range, "50 to 60k")).toEqual({
      value: 60_000,
      norm: { readings: [50_000, 60_000] },
      flags: [{ kind: "ambiguous_value", field: "f" }],
      verdict: "ambiguous",
    });
  });
});

describe("stage: verbatim from the quote", () => {
  it("finds the value word for word in the quote", () => {
    const said = "Move the Quarry Lane add-on to qualified to buy.";
    expect(check("verbatim", "Qualified to Buy", said, "to qualified to buy").verdict).toBe(
      "supported",
    );
    expect(kinds(check("verbatim", "closed won", said, "to qualified to buy"))).toEqual([
      "value_mismatch",
    ]);
  });
});

describe("free text: content-word overlap with the turn", () => {
  const turn = "Catherine Moore, their controller, asked for a revised invoice by Monday.";

  it("supports a value whose content words the turn mostly has", () => {
    // send, catherine, moore, revised, invoice: 4 of 5 in the turn.
    expect(contentWordOverlap("Send Catherine Moore a revised invoice", turn)).toBeCloseTo(0.8);
    expect(
      check("text", "Send Catherine Moore a revised invoice", turn, "a revised invoice"),
    ).toEqual({
      value: "Send Catherine Moore a revised invoice",
      flags: [],
      verdict: "supported",
      overlap: 0.8,
    });
  });

  it("flags weak support below 0.5, against the whole turn", () => {
    const result = check(
      "text",
      "Schedule a pricing workshop with procurement",
      turn,
      "a revised invoice",
    );
    expect(kinds(result)).toEqual(["weak_support"]);
    expect(result.verdict).toBe("weak");
    expect(result.overlap).toBe(0);
  });

  it("stems words and reads number words as digits", () => {
    expect(contentWordOverlap("Quoted 60 units", "They want a quote for sixty units.")).toBe(1);
    expect(contentWordOverlap("The deal is stalling", "Thistle is stalled on the deal.")).toBe(1);
    expect(contentWordOverlap("Okay, yes.", "Okay, yes.")).toBe(0);
  });
});

describe("corrections come before readings", () => {
  const d010 =
    "Muhammad Hassan wants it at one hundred eighty thousand, sorry, one hundred eighty-five thousand.";

  it("flags a quote of the value taken back, and a model that kept it", () => {
    expect(check("amount", 180_000, d010, "one hundred eighty thousand")).toEqual({
      value: 180_000,
      flags: [
        { kind: "self_correction", field: "f" },
        { kind: "value_mismatch", field: "f" },
      ],
      verdict: "mismatch",
    });
  });

  it("doesn't replace the right value with the retracted reading", () => {
    expect(check("amount", 185_000, d010, "one hundred eighty thousand")).toEqual({
      value: 185_000,
      flags: [{ kind: "self_correction", field: "f" }],
      verdict: "supported",
    });
  });

  it("reads a quote that runs past the marker as the new value", () => {
    const d012 = "Book a site visit at Sigma with Paloma on Tuesday, no wait, Wednesday.";
    const quote = "Tuesday, no wait, Wednesday";
    expect(
      check("date", "2026-12-09", d012, quote, { callTime: "2026-12-04T19:00:00.000Z" }),
    ).toEqual({ value: "2026-12-09", flags: [], verdict: "supported" });
    expect(check("date", "2026-12-08", d012, quote)).toEqual({
      value: "2026-12-09",
      norm: { llmValue: "2026-12-08" },
      flags: [
        { kind: "self_correction", field: "f" },
        { kind: "value_mismatch", field: "f" },
      ],
      verdict: "replaced",
    });
  });

  it("leaves the corrected quote alone", () => {
    expect(check("amount", 185_000, d010, "one hundred eighty-five thousand").flags).toEqual([]);
  });
});

describe("negation", () => {
  it("flags any field whose quote sits in a negation scope", () => {
    const d022 = "For Fernhill, I'm not quoting hardware yet, just the software.";
    const quote = "not quoting hardware yet, just the software";
    expect(
      kinds(check("text", "Quoting software only for now, not hardware.", d022, quote)),
    ).toEqual(["negation"]);
    expect(
      kinds(check("date", "2026-12-07", "We are not sending it by Monday.", "by Monday")),
    ).toEqual(["negation"]);
    expect(
      kinds(
        check("text", "Book a site visit", "Book a site visit, no problem.", "Book a site visit"),
      ),
    ).toEqual([]);
  });
});

describe("the rest", () => {
  it("leaves a null value unchecked", () => {
    expect(check("date", null, "Send it by Monday.", "by Monday")).toEqual({
      value: null,
      flags: [],
      verdict: "unchecked",
    });
  });

  it("knows how each proposal type's fields are checked", () => {
    expect(fieldKind("task", "dueDate")).toBe("date");
    expect(fieldKind("task", "title")).toBe("text");
    expect(fieldKind("contact", "title")).toBe("verbatim");
    expect(fieldKind("contact", "email")).toBe("email");
    expect(fieldKind("deal_update", "amount")).toBe("amount");
    expect(fieldKind("deal_update", "stage")).toBe("verbatim");
    expect(fieldKind("commitment", "counterpart")).toBe("name");
    expect(fieldKind("meeting", "time")).toBe("time");
    expect(fieldKind("note", "somethingNew")).toBe("text");
  });
});
