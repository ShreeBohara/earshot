import { describe, expect, it } from "vitest";
import { localDate, parseUsd, resolveDatePhrase } from "../src";

// Tuesday, 2026-11-10 11:15 in Los Angeles: the demo session's call (@earshot/agent's scenarios).
const DEMO_CALL = "2026-11-10T19:15:00.000Z";
const LA = "America/Los_Angeles";
const date = (quote: string, callTime = DEMO_CALL, timeZone = LA) =>
  resolveDatePhrase(quote, callTime, timeZone)?.date ?? null;

describe("localDate", () => {
  it("is the call's date where the rep is, not in UTC", () => {
    // 17:30 in Denver on Wednesday is already Thursday in UTC.
    expect(localDate("2026-12-10T00:30:00.000Z", "America/Denver")).toBe("2026-12-09");
    expect(localDate("2026-12-10T00:30:00.000Z", "UTC")).toBe("2026-12-10");
  });
});

describe("resolveDatePhrase", () => {
  it("resolves a bare weekday to the first one after the call, as the prompt tells the model", () => {
    // The demo's "by Thursday" is 2026-11-12, as its proposal says.
    expect(date("by Thursday")).toBe("2026-11-12");
    expect(date("on Monday")).toBe("2026-11-16");
    expect(date("Wednesday")).toBe("2026-11-11");
    expect(date("this Friday")).toBe("2026-11-13");
    // The call's own weekday means a week later.
    expect(date("by Tuesday")).toBe("2026-11-17");
  });

  it("counts days and weeks from the call's local date", () => {
    expect(date("tomorrow")).toBe("2026-11-11");
    expect(date("by tomorrow", "2026-12-10T00:30:00.000Z", "America/Denver")).toBe("2026-12-10");
    expect(date("today")).toBe("2026-11-10");
    expect(date("in two weeks")).toBe("2026-11-24");
    expect(date("in 3 days")).toBe("2026-11-13");
    expect(date("a week from today")).toBe("2026-11-17");
    expect(date("two weeks from today")).toBe("2026-11-24");
  });

  it("finds the end of the week and of the month", () => {
    expect(date("by the end of the week")).toBe("2026-11-13");
    expect(date("end of the week", "2026-11-13T20:00:00.000Z")).toBe("2026-11-13");
    expect(date("by the end of the month")).toBe("2026-11-30");
    expect(date("end of this month", "2027-02-10T20:00:00.000Z")).toBe("2027-02-28");
    expect(date("the end of next month", "2026-12-01T20:00:00.000Z")).toBe("2027-01-31");
  });

  it("puts a named date on its next occurrence, rolling into the next year", () => {
    expect(resolveDatePhrase("December 4th", DEMO_CALL, LA)).toEqual({
      date: "2026-12-04",
      relative: false,
    });
    expect(date("by January 15th")).toBe("2027-01-15");
    expect(date("November 10th")).toBe("2026-11-10");
    expect(date("November 9th")).toBe("2027-11-09");
    expect(date("February 30th")).toBeNull();
  });

  it("marks relative phrases as relative", () => {
    expect(resolveDatePhrase("by Friday", DEMO_CALL, LA)?.relative).toBe(true);
    expect(resolveDatePhrase("tomorrow", DEMO_CALL, LA)?.relative).toBe(true);
  });

  it("refuses ambiguous and unknown phrases", () => {
    expect(date("next Friday")).toBeNull();
    expect(date("soon")).toBeNull();
    expect(date("the week after next")).toBeNull();
    expect(date("in several weeks")).toBeNull();
  });
});

describe("parseUsd", () => {
  it("reads digits, with or without a dollar sign, commas, and a scale", () => {
    expect(parseUsd("$80,000")).toBe(80_000);
    expect(parseUsd("80,000 dollars")).toBe(80_000);
    expect(parseUsd("45k")).toBe(45_000);
    expect(parseUsd("1.2 million")).toBe(1_200_000);
    expect(parseUsd("$9,600")).toBe(9_600);
  });

  it("reads number words", () => {
    expect(parseUsd("forty-two thousand dollars")).toBe(42_000);
    expect(parseUsd("seventeen thousand five hundred")).toBe(17_500);
    expect(parseUsd("one hundred eighty-five thousand")).toBe(185_000);
    expect(parseUsd("a hundred and twenty thousand")).toBe(120_000);
    expect(parseUsd("nine thousand six hundred dollars")).toBe(9_600);
    expect(parseUsd("two million three hundred thousand")).toBe(2_300_000);
  });

  it("refuses anything else", () => {
    expect(parseUsd("the deal")).toBeNull();
    expect(parseUsd("seven thousand, actually")).toBeNull();
    expect(parseUsd("")).toBeNull();
  });
});
