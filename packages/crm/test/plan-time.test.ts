// Times in the rep's zone (Phase 6 spec §4.3): a date-only due date at 09:00 there, a meeting's
// date and time there, across changes of offset, and UTC for a zone `Intl` doesn't know.
import { describe, expect, it } from "vitest";
import {
  DUE_TIME,
  dueInstant,
  isCalendarDay,
  isClockTime,
  knownTimeZone,
  zonedInstant,
} from "../src";

describe("dueInstant", () => {
  it("is 09:00 in the rep's zone, on either side of autumn's change in Chicago", () => {
    expect(DUE_TIME).toBe("09:00");
    // DST ends at 02:00 on Sunday, November 1, 2026: CDT (UTC-5) before, CST (UTC-6) after.
    expect(dueInstant("2026-10-31", "America/Chicago")).toBe("2026-10-31T14:00:00.000Z");
    expect(dueInstant("2026-11-01", "America/Chicago")).toBe("2026-11-01T15:00:00.000Z");
    expect(dueInstant("2026-11-02", "America/Chicago")).toBe("2026-11-02T15:00:00.000Z");
  });

  it("follows spring's change too", () => {
    // DST starts at 02:00 on Sunday, March 14, 2027.
    expect(dueInstant("2027-03-13", "America/Chicago")).toBe("2027-03-13T15:00:00.000Z");
    expect(dueInstant("2027-03-14", "America/Chicago")).toBe("2027-03-14T14:00:00.000Z");
  });

  it("falls back to UTC for a zone Intl doesn't know, or none", () => {
    expect(dueInstant("2026-12-04", "Mars/Olympus_Mons")).toBe("2026-12-04T09:00:00.000Z");
    expect(knownTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(knownTimeZone(null)).toBe("UTC");
    expect(knownTimeZone("")).toBe("UTC");
    expect(knownTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("works where the offset isn't whole hours", () => {
    expect(dueInstant("2026-12-04", "Asia/Kolkata")).toBe("2026-12-04T03:30:00.000Z");
    expect(dueInstant("2026-12-04", "Asia/Kathmandu")).toBe("2026-12-04T03:15:00.000Z");
  });
});

describe("zonedInstant", () => {
  it("reads a meeting's date and time in the zone", () => {
    expect(zonedInstant("2026-12-03", "14:30", "America/Chicago")).toBe("2026-12-03T20:30:00.000Z");
    expect(zonedInstant("2026-12-03", "14:30", "Europe/London")).toBe("2026-12-03T14:30:00.000Z");
    expect(zonedInstant("2026-07-03", "14:30", "Europe/London")).toBe("2026-07-03T13:30:00.000Z");
  });

  it("reads a skipped time with the offset before the change, and a doubled one as the first", () => {
    // 02:30 on March 14, 2027 never happens in Chicago: it reads as 03:30 CDT.
    expect(zonedInstant("2027-03-14", "02:30", "America/Chicago")).toBe("2027-03-14T08:30:00.000Z");
    // 01:30 on November 1, 2026 happens twice: first in CDT.
    expect(zonedInstant("2026-11-01", "01:30", "America/Chicago")).toBe("2026-11-01T06:30:00.000Z");
  });

  it("is null for a date or a time that isn't one", () => {
    expect(zonedInstant("2026-02-30", "09:00", "UTC")).toBeNull();
    expect(zonedInstant("2026-12-3", "09:00", "UTC")).toBeNull();
    expect(zonedInstant("2026-12-03", "24:00", "UTC")).toBeNull();
    expect(zonedInstant("2026-12-03", "9:00", "UTC")).toBeNull();
  });

  it("checks days and times", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true);
    expect(isCalendarDay("2027-02-29")).toBe(false);
    expect(isCalendarDay(20261203)).toBe(false);
    expect(isClockTime("23:59")).toBe(true);
    expect(isClockTime("7:05")).toBe(false);
  });
});
