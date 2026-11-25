// Times in the rep's zone (Phase 6 spec §4.3): a task's date-only due date is 09:00 there, and a
// meeting starts at its date and time there, each as an ISO instant. The zone is `session.started`
// v2's, which the contract checks only for its shape, so one `Intl` doesn't know falls back to UTC.
// `Intl` alone, no time zone library: the edge Worker, the web Worker, and Node all ship its data.

/** When a date-only due date falls in the rep's day (§4.3). */
export const DUE_TIME = "09:00";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter of wall-clock parts in `timeZone`, or null when `Intl` doesn't know the zone. */
function formatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, made);
    return made;
  } catch {
    return null;
  }
}

/** The zone if `Intl` knows it, else `UTC`: a stored zone from another runtime's data, or none. */
export function knownTimeZone(timeZone: string | null | undefined): string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return "UTC";
  return formatter(timeZone) === null ? "UTC" : timeZone;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = (formatter(timeZone) ?? (formatter("UTC") as Intl.DateTimeFormat)).formatToParts(
    new Date(instant),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** A real calendar day, `YYYY-MM-DD`, as its UTC midnight in ms; null for anything else. */
function dayMs(date: string): number | null {
  const match = ISO_DAY.exec(date);
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (check.getUTCDate() !== day) return null;
  return ms;
}

/**
 * The instant a wall-clock date and time (`YYYY-MM-DD`, `HH:MM`) names in `timeZone` (UTC when
 * `Intl` doesn't know it), as an ISO string; null for a date or time that isn't one. Across a
 * change of offset it reads as Temporal's `compatible` does: a time the clocks skipped is read
 * with the offset before the change (02:30 on a spring-forward day is 03:30), and a time that
 * happened twice is the first of the two.
 */
export function zonedInstant(date: string, time: string, timeZone: string): string | null {
  const day = dayMs(date);
  const clock = CLOCK.exec(time);
  if (day === null || !clock) return null;
  const zone = knownTimeZone(timeZone);
  const wall = day + Number(clock[1]) * 3_600_000 + Number(clock[2]) * 60_000;
  const before = offsetAt(wall - DAY_MS, zone);
  const after = offsetAt(wall + DAY_MS, zone);
  const fits = [wall - before, wall - after]
    .filter((instant) => instant + offsetAt(instant, zone) === wall)
    .sort((a, b) => a - b);
  const instant = fits[0] ?? wall - before;
  return new Date(instant).toISOString();
}

/** A task's due instant: its date at `DUE_TIME` in the rep's zone (§4.3); null for a non-date. */
export function dueInstant(date: string, timeZone: string): string | null {
  return zonedInstant(date, DUE_TIME, timeZone);
}

/** Whether a value is a real calendar day, `YYYY-MM-DD`. */
export function isCalendarDay(value: unknown): value is string {
  return typeof value === "string" && dayMs(value) !== null;
}

/** Whether a value is a time of day, `HH:MM` on a 24-hour clock. */
export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}
