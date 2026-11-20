// The amount parser (spec WP7 step 2): digits, words, "k", "grand", "mil", "million", decimals,
// ranges, and USD, EUR, and GBP. The property test writes every kind of amount up to 999,999,999
// out in words and parses it back.
import { describe, expect, it } from "vitest";
import { findAmounts, parseAmount } from "../src/normalize";
import { int, mulberry32, type Random } from "./support/random";

const value = (quote: string) => parseAmount(quote)?.value ?? null;

describe("parseAmount", () => {
  it("reads digits, with commas, decimals, and a currency", () => {
    expect(parseAmount("$45,000")).toEqual({
      value: 45_000,
      readings: [45_000],
      currency: "USD",
      ambiguous: false,
    });
    expect(value("45000")).toBe(45_000);
    expect(value("$9,600.50")).toBe(9_600.5);
    expect(value("80,000 dollars")).toBe(80_000);
    expect(value("USD 50,000")).toBe(50_000);
  });

  it("reads number words, with or without 'and' and hyphens", () => {
    expect(value("forty-two thousand dollars")).toBe(42_000);
    expect(value("one hundred eighty-five thousand")).toBe(185_000);
    expect(value("a hundred and twenty thousand")).toBe(120_000);
    expect(value("eighty-one thousand five hundred")).toBe(81_500);
    expect(value("seven thousand five hundred")).toBe(7_500);
    expect(value("two million four hundred thousand")).toBe(2_400_000);
    expect(value("one thousand and five")).toBe(1_005);
    expect(value("forty-five hundred")).toBe(4_500);
    expect(value("twelve hundred")).toBe(1_200);
    expect(value("a million")).toBe(1_000_000);
  });

  it("reads the shorthand: k, grand, mil, M", () => {
    expect(value("45k")).toBe(45_000);
    expect(value("45 K")).toBe(45_000);
    expect(value("fifty k")).toBe(50_000);
    expect(value("40 grand")).toBe(40_000);
    expect(value("a grand")).toBe(1_000);
    expect(value("2 mil")).toBe(2_000_000);
    expect(value("$1.2M")).toBe(1_200_000);
    expect(value("$3mm")).toBe(3_000_000);
  });

  it("reads decimals and halves", () => {
    expect(value("1.5 million")).toBe(1_500_000);
    expect(value("2.5k")).toBe(2_500);
    expect(value("one point five million")).toBe(1_500_000);
    expect(value("half a million")).toBe(500_000);
    expect(value("one and a half million")).toBe(1_500_000);
    expect(value("a million and a half")).toBe(1_500_000);
  });

  it("names the currency the words name, and none when they name none", () => {
    expect(parseAmount("forty-two thousand dollars")?.currency).toBe("USD");
    expect(parseAmount("50 bucks")?.currency).toBe("USD");
    expect(parseAmount("€40k")?.currency).toBe("EUR");
    expect(parseAmount("40,000 euros")?.currency).toBe("EUR");
    expect(parseAmount("EUR 40,000")?.currency).toBe("EUR");
    expect(parseAmount("£30,000")?.currency).toBe("GBP");
    expect(parseAmount("thirty thousand pounds")?.currency).toBe("GBP");
    expect(parseAmount("thirty thousand pounds sterling")?.currency).toBe("GBP");
    expect(parseAmount("twenty grand")?.currency).toBeNull();
  });

  it("gives a range or alternatives two readings, the low end borrowing the scale", () => {
    expect(parseAmount("50 to 60k")).toEqual({
      value: 50_000,
      readings: [50_000, 60_000],
      currency: null,
      ambiguous: true,
    });
    expect(parseAmount("$50-60k")?.readings).toEqual([50_000, 60_000]);
    expect(parseAmount("$50,000-$60,000")?.readings).toEqual([50_000, 60_000]);
    expect(parseAmount("between fifty and sixty thousand")?.readings).toEqual([50_000, 60_000]);
    expect(parseAmount("fifty or sixty grand")?.readings).toEqual([50_000, 60_000]);
    expect(parseAmount("1.2 to 1.5 million")?.readings).toEqual([1_200_000, 1_500_000]);
    // A low end bigger than the high end's number keeps its own scale.
    expect(parseAmount("between 900 and 1.2 million")?.readings).toEqual([900, 1_200_000]);
    expect(parseAmount("between one hundred and two hundred thousand")?.readings).toEqual([
      100_000, 200_000,
    ]);
    expect(parseAmount("50 to 60k euros")?.currency).toBe("EUR");
  });

  it("reads the amount out of surrounding words", () => {
    expect(value("the starter plan at twenty-two thousand")).toBe(22_000);
    expect(value("bump it to seven thousand")).toBe(7_000);
  });

  it("lists every amount of a quote that names several, as ambiguous", () => {
    expect(parseAmount("seven thousand, actually seven thousand five hundred")).toMatchObject({
      readings: [7_000, 7_500],
      ambiguous: true,
    });
  });

  it("finds no amount in percentages, ordinals, times, or plain words", () => {
    expect(parseAmount("15%")).toBeNull();
    expect(parseAmount("fifteen percent")).toBeNull();
    expect(parseAmount("the 4th")).toBeNull();
    expect(parseAmount("at 3pm")).toBeNull();
    expect(parseAmount("a revised invoice")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("findAmounts", () => {
  it("finds each amount with its span, and marks lone small numbers bare", () => {
    const text = "Wants three more seats at forty thousand, sorry, forty-five thousand.";
    expect(findAmounts(text).map(({ text, value, bare }) => [text, value, bare])).toEqual([
      ["three", 3, true],
      ["forty thousand", 40_000, false],
      ["forty-five thousand", 45_000, false],
    ]);
  });
});

// ─── The property test ───────────────────────────────────────────────────────────────────────

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

interface Style {
  /** "one hundred and five" (British) rather than "one hundred five". */
  readonly and: boolean;
  /** "forty-two" rather than "forty two". */
  readonly hyphen: boolean;
  /** "a hundred", "a thousand" rather than "one hundred", "one thousand". */
  readonly article: boolean;
}

function belowHundred(n: number, style: Style): string {
  if (n < 20) return ONES[n] ?? "";
  const tens = TENS[Math.floor(n / 10)] ?? "";
  return n % 10 === 0 ? tens : `${tens}${style.hyphen ? "-" : " "}${ONES[n % 10]}`;
}

function belowThousand(n: number, style: Style, leading: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return belowHundred(rest, style);
  const head = `${leading && style.article && hundreds === 1 ? "a" : ONES[hundreds]} hundred`;
  if (rest === 0) return head;
  return `${head}${style.and ? " and " : " "}${belowHundred(rest, style)}`;
}

/** An integer from 0 to 999,999,999 in English words. */
function inWords(n: number, style: Style): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  const groups: [number, string][] = [
    [Math.floor(n / 1e6), "million"],
    [Math.floor(n / 1e3) % 1000, "thousand"],
  ];
  for (const [group, scale] of groups) {
    if (group === 0) continue;
    const words =
      parts.length === 0 && style.article && group === 1
        ? "a"
        : belowThousand(group, style, parts.length === 0);
    parts.push(`${words} ${scale}`);
  }
  const rest = n % 1000;
  if (rest > 0) {
    const words = belowThousand(rest, style, parts.length === 0);
    parts.push(parts.length > 0 && rest < 100 && style.and ? `and ${words}` : words);
  }
  return parts.join(" ");
}

/** Integers across every magnitude, so each group size gets its share. */
function sample(random: Random): number {
  const digits = int(random, 1, 9);
  return int(random, digits === 1 ? 0 : 10 ** (digits - 1), 10 ** digits - 1);
}

describe("every amount up to 999,999,999, written out in words, parses back", () => {
  it("with each style of writing it, on 4,000 seeded samples and the edges", () => {
    const random = mulberry32(20261119);
    const edges = [0, 1, 9, 10, 19, 20, 99, 100, 101, 110, 999, 1000, 1001, 1100, 10_000, 100_000];
    const numbers = [...edges, 999_999_999, 1_000_000, 100_000_000, 101_101_101];
    for (let k = 0; k < 4_000; k += 1) numbers.push(sample(random));
    for (const [index, n] of numbers.entries()) {
      const style = {
        and: index % 2 === 1,
        hyphen: index % 3 !== 2,
        article: index % 5 === 4,
      };
      const words = inWords(n, style);
      expect(parseAmount(words), words).toEqual({
        value: n,
        readings: [n],
        currency: null,
        ambiguous: false,
      });
      expect(value(`${words} dollars`), `${words} dollars`).toBe(n);
    }
  });

  it("and so do their digits, with and without commas", () => {
    const random = mulberry32(7);
    for (let k = 0; k < 1_000; k += 1) {
      const n = sample(random);
      expect(value(String(n))).toBe(n);
      expect(value(`$${n.toLocaleString("en-US")}`)).toBe(n);
    }
  });
});
