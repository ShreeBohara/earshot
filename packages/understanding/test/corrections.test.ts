// Self-corrections (spec WP7 step 4): a value, a marker right after it, and a value of the same
// kind right after the marker, in one utterance.
import { describe, expect, it } from "vitest";
import {
  CORRECTION_MARKERS,
  findAmounts,
  findCorrection,
  findCorrections,
  findDates,
  type ValueFinder,
} from "../src/normalize";

const CALL = "2026-12-04T19:00:00.000Z";
const NEW_YORK = "America/New_York";
const dates: ValueFinder = (text) => findDates(text, CALL, NEW_YORK);
const amounts: ValueFinder = (text) => findAmounts(text).filter((amount) => !amount.bare);

/** The correction that takes back a quote, as [taken back, said instead, marker, spans marker]. */
function correctionOf(text: string, quote: string, find: ValueFinder) {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`"${quote}" isn't in "${text}"`);
  const found = findCorrection(text, [start, start + quote.length], find);
  if (found === null) return null;
  return [
    text.slice(...found.retracted),
    text.slice(...found.replacement),
    found.marker,
    found.spansMarker,
  ];
}

// The three self-corrections in the scripts.
const D010 =
  "Harborview Marine renewal. Muhammad Hassan, their controller, wants it at one hundred eighty thousand, sorry, one hundred eighty-five thousand.";
const D012 = "Book a site visit at Sigma with Paloma on Tuesday, no wait, Wednesday.";
const D021 =
  "Move the Quarry Lane analytics add-on to qualified to buy, and bump it to seven thousand, actually seven thousand five hundred.";
const D029 =
  "The Sparrow close date moves to January 8th, sorry, January 6th, their first day back after the shutdown.";

describe("the scripts' self-corrections", () => {
  it("take back a quote that stops before the marker", () => {
    expect(correctionOf(D010, "one hundred eighty thousand", amounts)).toEqual([
      "one hundred eighty thousand",
      "one hundred eighty-five thousand",
      "sorry",
      false,
    ]);
    expect(correctionOf(D012, "Tuesday", dates)).toEqual([
      "on Tuesday",
      "Wednesday",
      "no wait",
      false,
    ]);
    // "seven thousand" first appears as the value taken back.
    expect(correctionOf(D021, "seven thousand", amounts)).toEqual([
      "seven thousand",
      "seven thousand five hundred",
      "actually",
      false,
    ]);
    expect(correctionOf(D029, "January 8th", dates)).toEqual([
      "January 8th",
      "January 6th",
      "sorry",
      false,
    ]);
  });

  it("leave the corrected value alone", () => {
    expect(correctionOf(D010, "one hundred eighty-five thousand", amounts)).toBeNull();
    expect(correctionOf(D012, "Wednesday", dates)).toBeNull();
    expect(correctionOf(D021, "seven thousand five hundred", amounts)).toBeNull();
    expect(correctionOf(D029, "January 6th", dates)).toBeNull();
  });

  it("see a quote that runs past the marker", () => {
    expect(correctionOf(D012, "Tuesday, no wait, Wednesday", dates)).toEqual([
      "on Tuesday",
      "Wednesday",
      "no wait",
      true,
    ]);
  });
});

describe("markers", () => {
  it("know the spec's markers", () => {
    const said = CORRECTION_MARKERS.map((marker) => marker.join(" "));
    for (const marker of ["sorry", "actually", "no wait", "i mean", "scratch that", "make that"]) {
      expect(said).toContain(marker);
    }
    expect(said).toContain("rather");
  });

  it("find each marker between two dates", () => {
    for (const marker of [
      "sorry",
      "actually",
      "no wait",
      "no, wait",
      "I mean",
      "scratch that",
      "make that",
      "or rather",
      "uh, sorry",
    ]) {
      const text = `Send it Tuesday, ${marker}, Wednesday.`;
      expect(correctionOf(text, "Tuesday", dates)?.slice(0, 2), marker).toEqual([
        "Tuesday",
        "Wednesday",
      ]);
    }
  });

  it("allow a few words before the new value", () => {
    expect(
      correctionOf(
        "Close at forty thousand, actually make it fifty thousand.",
        "forty thousand",
        amounts,
      ),
    ).toEqual(["forty thousand", "fifty thousand", "actually", false]);
    expect(
      correctionOf("Due Tuesday. Sorry, I mean it's due Wednesday.", "Tuesday", dates)?.slice(0, 2),
    ).toEqual(["Tuesday", "Wednesday"]);
  });

  it("follow a chain: every value but the last is taken back", () => {
    const text = "Tuesday, sorry, Wednesday, no wait, Thursday.";
    expect(findCorrections(text, dates).map((c) => [text.slice(...c.retracted), c.marker])).toEqual(
      [
        ["Tuesday", "sorry"],
        ["Wednesday", "no wait"],
      ],
    );
    expect(correctionOf(text, "Wednesday", dates)?.[1]).toBe("Thursday");
    expect(correctionOf(text, "Thursday", dates)).toBeNull();
  });
});

describe("what isn't a correction", () => {
  it("needs a value of the same kind after the marker", () => {
    expect(correctionOf("We close Friday, actually, which is great.", "Friday", dates)).toBeNull();
    expect(
      correctionOf(
        "Forty thousand, sorry, one more thing: they want a pilot.",
        "Forty thousand",
        amounts,
      ),
    ).toBeNull();
  });

  it("needs the marker right after the value", () => {
    expect(
      correctionOf(
        "Kickoff is Tuesday with the whole team, actually Wednesday works better.",
        "Tuesday",
        dates,
      ),
    ).toBeNull();
  });

  it("doesn't reach past the words allowed before the new value", () => {
    expect(
      correctionOf(
        "Send it Tuesday, sorry, the team said they would rather wait until Friday.",
        "Tuesday",
        dates,
      ),
    ).toBeNull();
  });
});
