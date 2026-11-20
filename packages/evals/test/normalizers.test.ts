// The product's normalizers and faithfulness check (@earshot/understanding, spec WP7) against the
// 30 hand-written debrief scripts, and the conformance test of decision 13: the evals keep their
// own date and amount resolvers (src/verify.ts), and the two implementations must agree on every
// ground-truth phrase, so one bug can't pass both sides. The unit tests are in
// @earshot/understanding (test/dates, amounts, negation, corrections, faithfulness).
import type {
  FieldNorm as CoreFieldNorm,
  FieldValue as CoreFieldValue,
  RiskFlagV2,
  RiskKindV2,
} from "@earshot/core";
import {
  checkField,
  type FieldFlag,
  type FieldFlagKind,
  type FieldNorm,
  type FieldValue,
  fieldKind,
} from "@earshot/understanding/faithfulness";
import {
  isNegated,
  negationScopes,
  parseAmount,
  resolveDate,
} from "@earshot/understanding/normalize";
import { describe, expect, it } from "vitest";
import { DEBRIEFS, type DebriefScript, parseUsd, resolveDatePhrase } from "../src";

interface ScriptedField {
  readonly script: DebriefScript;
  readonly turn: number;
  readonly text: string;
  readonly type: string;
  readonly field: string;
  readonly value: string | number;
  readonly quote: string;
}

const FIELDS: readonly ScriptedField[] = DEBRIEFS.flatMap((script) =>
  script.turns.flatMap((turn, index) =>
    turn.expect.flatMap((proposal) =>
      Object.entries(proposal.fields).map(([field, expected]) => ({
        script,
        turn: index,
        text: turn.text,
        type: proposal.type,
        field,
        value: expected.value,
        quote: expected.quote,
      })),
    ),
  ),
);
const DATES = FIELDS.filter((field) => fieldKind(field.type, field.field) === "date");
const AMOUNTS = FIELDS.filter((field) => fieldKind(field.type, field.field) === "amount");
const where = (field: ScriptedField) =>
  `${field.script.id} turn ${field.turn + 1}: "${field.quote}"`;

function checkScripted(field: ScriptedField, value: FieldValue = field.value, quote = field.quote) {
  const start = field.text.indexOf(quote);
  if (start < 0) throw new Error(`${where(field)} isn't in its turn`);
  return checkField(
    {
      field: field.field,
      kind: fieldKind(field.type, field.field),
      value,
      utterance: field.text,
      span: [start, start + quote.length],
    },
    { turnText: field.text, callTime: field.script.callTime, timeZone: field.script.timeZone },
  );
}

// @earshot/understanding restates the contract shapes it shares instead of importing
// @earshot/core (whose session tickets need Web Crypto types a DOM-free program lacks). This fails
// to compile if the two drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Within<A, B> = [A] extends [B] ? true : false;
const CONTRACTS_AGREE: [
  Same<FieldNorm, CoreFieldNorm>,
  Same<FieldValue, CoreFieldValue>,
  Within<FieldFlagKind, RiskKindV2>,
  Within<FieldFlag, RiskFlagV2>,
] = [true, true, true, true];

describe("the faithfulness check's types", () => {
  it("restate the contracts' exactly", () => {
    expect(CONTRACTS_AGREE).toEqual([true, true, true, true]);
  });
});

describe("the 30 scripts' expected values", () => {
  it("cover dates and amounts", () => {
    expect(DEBRIEFS).toHaveLength(30);
    expect(DATES.length).toBe(37);
    expect(AMOUNTS.length).toBe(13);
  });

  it("every scripted date resolves to its expected value, alone and certain", () => {
    for (const field of DATES) {
      const resolved = resolveDate(field.quote, field.script.callTime, field.script.timeZone);
      expect(resolved, where(field)).toMatchObject({ readings: [field.value], certain: true });
    }
  });

  it("every scripted amount parses to its expected value, in dollars or no currency", () => {
    for (const field of AMOUNTS) {
      const parsed = parseAmount(field.quote);
      expect(parsed, where(field)).toMatchObject({ value: field.value, ambiguous: false });
      expect([null, "USD"], where(field)).toContain(parsed?.currency);
    }
  });

  it("every expected field passes the faithfulness check, unchanged and unflagged", () => {
    for (const field of FIELDS) {
      const result = checkScripted(field);
      // Nothing right is ever replaced.
      expect(result.value, where(field)).toBe(field.value);
      expect(result.verdict, where(field)).toBe("supported");
      // Negation is the only flag a right value may carry: a negated quote is worth a look anyway.
      expect(
        result.flags.filter((flag) => flag.kind !== "negation"),
        where(field),
      ).toEqual([]);
    }
    // Phase 3's scripts expanded three company names past their quotes ("Akme" written "Akme
    // Dynamics"), which the Phase 3 prompt could do from the CRM list. The v2 extractor no longer
    // sees it (decision 1), so WP8 writes names as said, and the linker resolves the company.
    const named = (id: string, name: string) =>
      FIELDS.find((field) => field.script.id === id && field.field === name)?.value;
    expect([
      named("d002", "company"),
      named("d012", "company"),
      named("d027", "counterpart"),
    ]).toEqual(["Akme", "Sigma", "Verdant"]);
  });

  it("a wrong date or amount, like a model's, is replaced with the expected value", () => {
    for (const field of [...DATES, ...AMOUNTS]) {
      const wrong =
        typeof field.value === "number"
          ? field.value * 10
          : new Date(Date.parse(`${field.value}T00:00:00Z`) + 86_400_000)
              .toISOString()
              .slice(0, 10);
      const result = checkScripted(field, wrong);
      expect(result, where(field)).toMatchObject({
        value: field.value,
        norm: { llmValue: wrong },
        verdict: "replaced",
      });
      expect(result.flags.map((flag) => flag.kind)).toContain("value_mismatch");
    }
  });
});

describe("the scripts' self-corrections", () => {
  // A model that quotes, and keeps, the value the rep took back.
  const RETRACTED: readonly [id: string, field: string, value: string | number, quote: string][] = [
    ["d010", "amount", 180_000, "one hundred eighty thousand"],
    ["d012", "dueDate", "2026-12-08", "Tuesday"],
    ["d021", "amount", 7_000, "seven thousand"],
    ["d029", "closeDate", "2027-01-08", "January 8th"],
  ];

  it("leave the expected quote, the corrected value, unflagged", () => {
    for (const [id, name] of RETRACTED) {
      const field = FIELDS.find((item) => item.script.id === id && item.field === name);
      if (!field) throw new Error(`no ${name} in ${id}`);
      expect(checkScripted(field).flags, where(field)).toEqual([]);
    }
  });

  it("flag a quote of the retracted value, and a model that kept it, without replacing it", () => {
    for (const [id, name, value, quote] of RETRACTED) {
      const field = FIELDS.find((item) => item.script.id === id && item.field === name);
      if (!field) throw new Error(`no ${name} in ${id}`);
      const kept = checkScripted(field, value, quote);
      expect(kept.value, id).toBe(value);
      expect(
        kept.flags.map((flag) => flag.kind),
        id,
      ).toEqual(["self_correction", "value_mismatch"]);
      // The right value against the retracted words: only the quote is wrong.
      const fixed = checkScripted(field, field.value, quote);
      expect(fixed.value, id).toBe(field.value);
      expect(
        fixed.flags.map((flag) => flag.kind),
        id,
      ).toEqual(["self_correction"]);
    }
  });
});

describe("the scripts' negations", () => {
  it("every turn tagged as a negation has a negation scope", () => {
    const tagged = DEBRIEFS.flatMap((script) =>
      script.turns.filter((turn) => turn.tags?.includes("negation")).map((turn) => turn.text),
    );
    expect(tagged.length).toBeGreaterThanOrEqual(15);
    for (const text of tagged) expect(negationScopes(text), text).not.toEqual([]);
  });

  it("d007 negates Pacific Crest", () => {
    const text = DEBRIEFS.find((script) => script.id === "d007")?.turns[2]?.text ?? "";
    const start = text.indexOf("Pacific Crest");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(isNegated(text, [start, start + "Pacific Crest".length])).toBe(true);
  });
});

// ─── Decision 13: the evals' resolvers and the product's agree ───────────────────────────────

// Tuesday, 2026-11-10 11:15 in Los Angeles, the evals' own unit tests' call (test/verify.test.ts),
// with the phrases those tests resolve.
const DEMO_CALL = "2026-11-10T19:15:00.000Z";
const LA = "America/Los_Angeles";
const PHRASES: readonly [quote: string, callTime: string, timeZone: string][] = [
  ...[
    "by Thursday",
    "on Monday",
    "Wednesday",
    "this Friday",
    "by Tuesday",
    "tomorrow",
    "today",
    "in two weeks",
    "in 3 days",
    "a week from today",
    "two weeks from today",
    "by the end of the week",
    "by the end of the month",
    "December 4th",
    "by January 15th",
    "November 10th",
    "November 9th",
  ].map((quote): [string, string, string] => [quote, DEMO_CALL, LA]),
  ["by tomorrow", "2026-12-10T00:30:00.000Z", "America/Denver"],
  ["end of the week", "2026-11-13T20:00:00.000Z", LA],
  ["end of this month", "2027-02-10T20:00:00.000Z", LA],
  ["the end of next month", "2026-12-01T20:00:00.000Z", LA],
];
const REFUSED = ["next Friday", "soon", "the week after next", "in several weeks", "February 30th"];
const AMOUNT_PHRASES = [
  "$80,000",
  "80,000 dollars",
  "45k",
  "1.2 million",
  "$9,600",
  "forty-two thousand dollars",
  "seventeen thousand five hundred",
  "one hundred eighty-five thousand",
  "a hundred and twenty thousand",
  "nine thousand six hundred dollars",
  "two million three hundred thousand",
];

describe("the conformance test (decision 13)", () => {
  it("agrees with resolveDatePhrase on every ground-truth date, relative or not", () => {
    for (const field of DATES) {
      const { callTime, timeZone } = field.script;
      const theirs = resolveDatePhrase(field.quote, callTime, timeZone);
      const ours = resolveDate(field.quote, callTime, timeZone);
      expect(theirs, where(field)).not.toBeNull();
      expect(ours, where(field)).toEqual({
        readings: [theirs?.date],
        certain: true,
        relative: theirs?.relative,
      });
    }
  });

  it("agrees with parseUsd on every ground-truth amount", () => {
    for (const field of AMOUNTS) {
      expect(parseAmount(field.quote)?.value, where(field)).toBe(parseUsd(field.quote));
    }
  });

  it("agrees on the phrases the evals' own tests resolve", () => {
    for (const [quote, callTime, timeZone] of PHRASES) {
      const theirs = resolveDatePhrase(quote, callTime, timeZone);
      expect(resolveDate(quote, callTime, timeZone), quote).toEqual({
        readings: [theirs?.date],
        certain: true,
        relative: theirs?.relative,
      });
    }
    for (const quote of AMOUNT_PHRASES) {
      expect(parseAmount(quote), quote).toMatchObject({ value: parseUsd(quote), ambiguous: false });
    }
  });

  it("never pins one day where the evals refuse to", () => {
    for (const quote of REFUSED) {
      expect(resolveDatePhrase(quote, DEMO_CALL, LA), quote).toBeNull();
      const ours = resolveDate(quote, DEMO_CALL, LA);
      const pinned = ours?.certain === true && ours.readings.length === 1;
      expect(pinned, quote).toBe(false);
    }
  });
});
