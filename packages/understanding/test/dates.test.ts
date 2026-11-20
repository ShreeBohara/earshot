// The date normalizer (spec WP7 step 1): chrono-node's casual English parser with the call's
// offset from Intl, components rather than `date()`, and Earshot's rules on top. The tables:
// a daylight-saving change (America/Chicago, 2026-11-01), a weekday said on that weekday, both
// readings of "next Friday", and the end-of-period rules.
import { casual } from "chrono-node/en";
import { afterEach, describe, expect, it } from "vitest";
import {
  callDate,
  findDates,
  offsetChangesOn,
  resolveDate,
  resolveTime,
  timeZoneOffset,
} from "../src/normalize";

const CHICAGO = "America/Chicago";
const LA = "America/Los_Angeles";
// Tuesday 2026-11-17, 14:20 in Los Angeles: an afternoon call.
const TUESDAY_PM = "2026-11-17T22:20:00.000Z";
// The same Tuesday at 08:00 in Los Angeles: a morning call.
const TUESDAY_AM = "2026-11-17T16:00:00.000Z";

const readings = (quote: string, callTime = TUESDAY_PM, timeZone = LA) =>
  resolveDate(quote, callTime, timeZone)?.readings ?? null;

describe("the reference", () => {
  it("takes the offset from Intl at the call instant, either side of a change", () => {
    // 01:30 happens twice in Chicago on 2026-11-01: first in CDT, then in CST.
    expect(timeZoneOffset(new Date("2026-11-01T06:30:00Z"), CHICAGO)).toBe(-300);
    expect(timeZoneOffset(new Date("2026-11-01T07:30:00Z"), CHICAGO)).toBe(-360);
    expect(timeZoneOffset(new Date("2026-07-01T12:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(timeZoneOffset(new Date("2026-07-01T12:00:00Z"), "UTC")).toBe(0);
  });

  it("dates the call where the rep is, not in UTC", () => {
    // 17:30 on Wednesday in Denver is already Thursday in UTC.
    expect(callDate("2026-12-10T00:30:00.000Z", "America/Denver")).toBe("2026-12-09");
    expect(callDate("2026-12-10T00:30:00.000Z", "UTC")).toBe("2026-12-10");
    expect(readings("by tomorrow", "2026-12-10T00:30:00.000Z", "America/Denver")).toEqual([
      "2026-12-10",
    ]);
  });

  it("refuses an invalid instant or time zone", () => {
    expect(() => resolveDate("tomorrow", "not a time", LA)).toThrow(RangeError);
    expect(() => resolveDate("tomorrow", TUESDAY_PM, "Mars/Olympus_Mons")).toThrow(RangeError);
  });

  it("is null for a quote with no date", () => {
    expect(resolveDate("a revised invoice", TUESDAY_PM, LA)).toBeNull();
    expect(resolveDate("", TUESDAY_PM, LA)).toBeNull();
  });
});

describe("weekdays", () => {
  it("puts a bare weekday on the first one after the call", () => {
    expect(readings("by Friday")).toEqual(["2026-11-20"]);
    expect(readings("on Monday")).toEqual(["2026-11-23"]);
    expect(readings("Wednesday")).toEqual(["2026-11-18"]);
    expect(readings("this Friday")).toEqual(["2026-11-20"]);
    expect(readings("this coming Friday")).toEqual(["2026-11-20"]);
  });

  it("puts the call's own weekday a week later, morning or afternoon", () => {
    // chrono alone gives today for a morning call and next week for an afternoon one.
    for (const call of [TUESDAY_AM, TUESDAY_PM]) {
      expect(readings("Tuesday", call)).toEqual(["2026-11-24"]);
      expect(readings("by Tuesday", call)).toEqual(["2026-11-24"]);
      expect(readings("this Tuesday", call)).toEqual(["2026-11-24"]);
    }
  });

  it("gives 'next Friday' both readings, the coming one and the one after", () => {
    // Said on Tuesday: this week's Friday (3 days) or next week's (10, chrono's reading).
    expect(resolveDate("next Friday", TUESDAY_PM, LA)).toEqual({
      readings: ["2026-11-20", "2026-11-27"],
      certain: true,
      relative: true,
    });
    // Said on the Friday itself, on a Saturday, and on a Sunday.
    expect(readings("next Friday", "2026-11-20T18:00:00Z")).toEqual(["2026-11-27", "2026-12-04"]);
    expect(readings("next Friday", "2026-11-21T18:00:00Z")).toEqual(["2026-11-27", "2026-12-04"]);
    expect(readings("next Friday", "2026-11-22T18:00:00Z")).toEqual(["2026-11-27", "2026-12-04"]);
    expect(readings("next Tuesday")).toEqual(["2026-11-24", "2026-12-01"]);
  });

  it("gives one reading when the week or the date settles it", () => {
    expect(readings("Friday next week")).toEqual(["2026-11-27"]);
    expect(readings("Friday of next week")).toEqual(["2026-11-27"]);
    expect(readings("next week Friday")).toEqual(["2026-11-27"]);
    expect(readings("Wednesday this week")).toEqual(["2026-11-18"]);
    expect(readings("next Friday the 27th")).toEqual(["2026-11-27"]);
    expect(readings("Friday the 27th")).toEqual(["2026-11-27"]);
    expect(readings("Friday, December 4th")).toEqual(["2026-12-04"]);
  });

  it("keeps both readings when a weekday contradicts its date", () => {
    // 2026-12-04 is a Friday.
    expect(readings("Thursday, December 4th")).toEqual(["2026-12-04", "2026-11-19"]);
  });

  it("looks back for 'last Friday', whatever forwardDate does", () => {
    expect(readings("last Friday")).toEqual(["2026-11-13"]);
  });

  it("doesn't pin a weekend to a day", () => {
    expect(resolveDate("this weekend", TUESDAY_PM, LA)).toMatchObject({ certain: false });
  });
});

describe("the end of a period", () => {
  it("ends the week on its Friday, today on a Friday, the coming one at a weekend", () => {
    expect(readings("by the end of the week")).toEqual(["2026-11-20"]);
    expect(readings("EOW")).toEqual(["2026-11-20"]);
    expect(readings("end of this week")).toEqual(["2026-11-20"]);
    expect(readings("end of the week", "2026-11-20T18:00:00Z")).toEqual(["2026-11-20"]);
    expect(readings("end of the week", "2026-11-21T18:00:00Z")).toEqual(["2026-11-27"]);
    expect(readings("end of the week", "2026-11-22T18:00:00Z")).toEqual(["2026-11-27"]);
    expect(readings("end of next week")).toEqual(["2026-11-27"]);
  });

  it("ends the month on its last day", () => {
    expect(readings("by the end of the month")).toEqual(["2026-11-30"]);
    expect(readings("EOM")).toEqual(["2026-11-30"]);
    expect(readings("end of this month", "2027-02-10T20:00:00Z")).toEqual(["2027-02-28"]);
    expect(readings("the end of next month", "2026-12-01T20:00:00Z")).toEqual(["2027-01-31"]);
    expect(readings("end of December")).toEqual(["2026-12-31"]);
  });

  it("ends the quarter on the calendar quarter's last day", () => {
    expect(readings("EOQ")).toEqual(["2026-12-31"]);
    expect(readings("by the end of the quarter", "2026-02-03T18:00:00Z")).toEqual(["2026-03-31"]);
    expect(readings("end of next quarter")).toEqual(["2027-03-31"]);
    expect(readings("end of next quarter", "2026-08-03T18:00:00Z")).toEqual(["2026-12-31"]);
    expect(readings("end of Q1")).toEqual(["2027-03-31"]);
    expect(readings("end of Q4")).toEqual(["2026-12-31"]);
  });

  it("ends the day today, unless the quote names the day", () => {
    expect(readings("EOD")).toEqual(["2026-11-17"]);
    expect(readings("by close of business")).toEqual(["2026-11-17"]);
    expect(readings("end of day")).toEqual(["2026-11-17"]);
    expect(readings("EOD Friday")).toEqual(["2026-11-20"]);
    expect(readings("end of day tomorrow")).toEqual(["2026-11-18"]);
    expect(readings("by close of business on Friday")).toEqual(["2026-11-20"]);
    expect(readings("Friday EOD")).toEqual(["2026-11-20"]);
    // An EOD elsewhere in the utterance still means today.
    expect(readings("Send the deck EOD, and the contract by Friday.")).toEqual([
      "2026-11-17",
      "2026-11-20",
    ]);
  });

  it("ends the year on December 31", () => {
    expect(readings("EOY")).toEqual(["2026-12-31"]);
    expect(readings("by the end of the year")).toEqual(["2026-12-31"]);
    expect(readings("end of next year")).toEqual(["2027-12-31"]);
  });
});

describe("other relative dates", () => {
  it("counts days and weeks from the call's local date", () => {
    expect(readings("today")).toEqual(["2026-11-17"]);
    expect(readings("tomorrow")).toEqual(["2026-11-18"]);
    expect(readings("the day after tomorrow")).toEqual(["2026-11-19"]);
    expect(readings("in two weeks")).toEqual(["2026-12-01"]);
    expect(readings("in 3 days")).toEqual(["2026-11-20"]);
    expect(readings("a week from today")).toEqual(["2026-11-24"]);
    expect(readings("two weeks from today")).toEqual(["2026-12-01"]);
    expect(readings("a week from tomorrow")).toEqual(["2026-11-25"]);
    expect(readings("in a fortnight")).toEqual(["2026-12-01"]);
  });

  it("puts a day of the month alone on its next occurrence", () => {
    expect(readings("by the 15th")).toEqual(["2026-12-15"]);
    expect(readings("the 17th")).toEqual(["2026-11-17"]);
    expect(readings("the 31st")).toEqual(["2026-12-31"]);
    expect(readings("the 1st of next month")).toEqual(["2026-12-01"]);
    expect(readings("the 30th of this month")).toEqual(["2026-11-30"]);
  });

  it("marks relative phrases relative, and named dates not", () => {
    expect(resolveDate("by Friday", TUESDAY_PM, LA)?.relative).toBe(true);
    expect(resolveDate("in two weeks", TUESDAY_PM, LA)?.relative).toBe(true);
    expect(resolveDate("December 4th", TUESDAY_PM, LA)?.relative).toBe(false);
  });
});

describe("named dates", () => {
  it("puts a month and day on the next one on or after the call's date", () => {
    expect(readings("December 4th")).toEqual(["2026-12-04"]);
    expect(readings("by January 15th")).toEqual(["2027-01-15"]);
    expect(readings("November 17th")).toEqual(["2026-11-17"]);
    expect(readings("November 16th")).toEqual(["2027-11-16"]);
    expect(readings("12/4")).toEqual(["2026-12-04"]);
    expect(readings("the 4th of December")).toEqual(["2026-12-04"]);
  });

  it("keeps a year that was said", () => {
    expect(readings("December 31st 2027")).toEqual(["2027-12-31"]);
    expect(readings("2026-12-04")).toEqual(["2026-12-04"]);
  });
});

describe("what isn't certain", () => {
  it("guesses at the day of a period, and says so", () => {
    for (const quote of ["next week", "early next week", "next month", "in December", "by Q1"]) {
      expect(resolveDate(quote, TUESDAY_PM, LA), quote).toMatchObject({ certain: false });
    }
    expect(resolveDate("in a couple of weeks", TUESDAY_PM, LA)).toMatchObject({ certain: false });
    expect(resolveDate("the week after next", TUESDAY_PM, LA)).toMatchObject({ certain: false });
  });

  it("lists every reading of a quote with several dates, up to three", () => {
    expect(readings("Tuesday or Wednesday")).toEqual(["2026-11-24", "2026-11-18"]);
    expect(readings("Monday, Tuesday, Wednesday, or Thursday")).toBeNull();
  });

  it("finds each expression and where it is", () => {
    const text = "Book it on Tuesday, no wait, Wednesday.";
    expect(findDates(text, TUESDAY_PM, LA).map(({ text, readings }) => [text, readings])).toEqual([
      ["on Tuesday", ["2026-11-24"]],
      ["Wednesday", ["2026-11-18"]],
    ]);
  });
});

// ─── Daylight saving ─────────────────────────────────────────────────────────────────────────

interface DstRow {
  readonly call: string;
  readonly said: string;
  readonly expect: Readonly<Record<string, string | readonly string[]>>;
}

// America/Chicago leaves daylight time at 02:00 CDT on Sunday 2026-11-01 (07:00Z); 01:00 to
// 02:00 happens twice. It enters it at 02:00 CST on Sunday 2026-03-08 (08:00Z).
const DST_TABLE: readonly DstRow[] = [
  {
    call: "2026-10-25T05:30:00Z",
    said: "Sun 10-25 00:30 CDT",
    expect: {
      today: "2026-10-25",
      tomorrow: "2026-10-26",
      "in a week": "2026-11-01",
      "in two weeks": "2026-11-08",
      "a week from today": "2026-11-01",
      Sunday: "2026-11-01",
      "next Sunday": ["2026-11-01", "2026-11-08"],
      Monday: "2026-10-26",
      "end of the week": "2026-10-30",
      "end of the month": "2026-10-31",
    },
  },
  {
    call: "2026-11-01T04:30:00Z",
    said: "Sat 10-31 23:30 CDT",
    expect: {
      today: "2026-10-31",
      tomorrow: "2026-11-01",
      "in two days": "2026-11-02",
      "in a week": "2026-11-07",
      Sunday: "2026-11-01",
      Monday: "2026-11-02",
      "next Monday": ["2026-11-02", "2026-11-09"],
      "end of the week": "2026-11-06",
      "end of the month": "2026-10-31",
      "end of next month": "2026-11-30",
    },
  },
  {
    call: "2026-11-01T05:30:00Z",
    said: "Sun 11-01 00:30 CDT",
    expect: {
      today: "2026-11-01",
      tomorrow: "2026-11-02",
      "in a week": "2026-11-08",
      Sunday: "2026-11-08",
      "end of the week": "2026-11-06",
    },
  },
  {
    call: "2026-11-01T06:30:00Z",
    said: "Sun 11-01 01:30 CDT (the first 01:30)",
    expect: {
      today: "2026-11-01",
      tomorrow: "2026-11-02",
      Monday: "2026-11-02",
      Sunday: "2026-11-08",
      "next Sunday": ["2026-11-08", "2026-11-15"],
      "in two weeks": "2026-11-15",
      "end of the month": "2026-11-30",
    },
  },
  {
    call: "2026-11-01T07:30:00Z",
    said: "Sun 11-01 01:30 CST (the second 01:30)",
    expect: {
      today: "2026-11-01",
      tomorrow: "2026-11-02",
      Monday: "2026-11-02",
      Sunday: "2026-11-08",
      "next Sunday": ["2026-11-08", "2026-11-15"],
      "in two weeks": "2026-11-15",
      "end of the month": "2026-11-30",
    },
  },
  {
    call: "2026-11-01T09:00:00Z",
    said: "Sun 11-01 03:00 CST",
    expect: { today: "2026-11-01", tomorrow: "2026-11-02", "in a week": "2026-11-08" },
  },
  {
    call: "2026-11-02T05:30:00Z",
    said: "Sun 11-01 23:30 CST",
    expect: {
      today: "2026-11-01",
      tomorrow: "2026-11-02",
      Monday: "2026-11-02",
      "in a week": "2026-11-08",
    },
  },
  {
    call: "2026-03-08T05:30:00Z",
    said: "Sat 03-07 23:30 CST, before the spring change",
    expect: { tomorrow: "2026-03-08", Monday: "2026-03-09", "in a week": "2026-03-14" },
  },
];

function checkTable() {
  for (const row of DST_TABLE) {
    for (const [quote, expected] of Object.entries(row.expect)) {
      const want = typeof expected === "string" ? [expected] : expected;
      expect(readings(quote, row.call, CHICAGO), `${quote}, said ${row.said}`).toEqual(want);
    }
  }
}

/** What reading `date()` and converting the instant back would give: the mistake to avoid. */
function viaInstant(quote: string, callTime: string): string {
  const instant = new Date(callTime);
  const [result] = casual.parse(
    quote,
    { instant, timezone: timeZoneOffset(instant, CHICAGO) },
    { forwardDate: true },
  );
  if (!result) throw new Error(`chrono read nothing in ${quote}`);
  return callDate(result.start.date(), CHICAGO);
}

describe("a daylight-saving change (America/Chicago, 2026-11-01)", () => {
  const systemZone = process.env.TZ;
  afterEach(() => {
    if (systemZone === undefined) delete process.env.TZ;
    else process.env.TZ = systemZone;
  });

  it("reads the day from components, so the change can't move it", () => {
    checkTable();
  });

  it("would have moved the day with date() (the control)", () => {
    // date() builds the instant with the call's offset, an hour off once the clocks change, so a
    // relative date reached just after midnight lands on the evening before.
    expect(viaInstant("in two weeks", "2026-10-25T05:30:00Z")).toBe("2026-11-07");
    expect(readings("in two weeks", "2026-10-25T05:30:00Z", CHICAGO)).toEqual(["2026-11-08"]);
    expect(viaInstant("tomorrow", "2026-11-01T05:30:00Z")).toBe("2026-11-01");
    expect(readings("tomorrow", "2026-11-01T05:30:00Z", CHICAGO)).toEqual(["2026-11-02"]);
    // In spring the hour goes the other way: late evening lands on the next day.
    expect(viaInstant("in a week", "2026-03-08T05:30:00Z")).toBe("2026-03-15");
  });

  it("gives the same table whatever the system's own time zone", () => {
    // chrono shifts its reference into the system's zone; workerd runs in UTC, laptops don't.
    for (const zone of ["UTC", CHICAGO, "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      checkTable();
    }
  });

  it("knows which days the clocks change on", () => {
    expect(offsetChangesOn("2026-11-01", CHICAGO)).toBe(true);
    expect(offsetChangesOn("2026-03-08", CHICAGO)).toBe(true);
    expect(offsetChangesOn("2026-11-02", CHICAGO)).toBe(false);
    expect(offsetChangesOn("2026-10-31", CHICAGO)).toBe(false);
    expect(offsetChangesOn("2026-11-01", "Asia/Kolkata")).toBe(false);
    expect(offsetChangesOn("not a date", CHICAGO)).toBe(false);
  });
});

describe("times", () => {
  it("reads a time with its meridiem as one reading", () => {
    expect(resolveTime("3pm")).toEqual({ readings: ["15:00"], certain: true });
    expect(resolveTime("at 10am")).toEqual({ readings: ["10:00"], certain: true });
    expect(resolveTime("noon")).toEqual({ readings: ["12:00"], certain: true });
    expect(resolveTime("midnight")).toEqual({ readings: ["00:00"], certain: true });
    expect(resolveTime("at 15:30")).toEqual({ readings: ["15:30"], certain: true });
  });

  it("gives an hour without a meridiem both readings, business hours first", () => {
    expect(resolveTime("at 3")).toEqual({ readings: ["15:00", "03:00"], certain: true });
    expect(resolveTime("at 9")).toEqual({ readings: ["09:00", "21:00"], certain: true });
    expect(resolveTime("at 3:30")).toEqual({ readings: ["15:30", "03:30"], certain: true });
  });

  it("guesses at a part of the day, and says so", () => {
    expect(resolveTime("this afternoon")).toEqual({ readings: ["15:00"], certain: false });
    expect(resolveTime("December 4th")).toBeNull();
    expect(resolveTime("the deck")).toBeNull();
  });
});
