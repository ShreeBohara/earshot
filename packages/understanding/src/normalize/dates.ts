// Dates (spec WP7 step 1; decision 9): a quote resolved against the call time in the rep's time
// zone, with chrono-node's casual English parser and Earshot's rules on top.
//
// - **The reference:** `{ instant: callTime, timezone: offsetMinutes }`, the offset computed by
//   `Intl` for the call instant. chrono reads only abbreviations and minute offsets, never IANA
//   names. `forwardDate` is on.
// - **Components, never `date()`:** a date-only field reads chrono's year, month, and day.
//   `date()` builds an instant with the call's offset, which is an hour off across a
//   daylight-saving change, and a day off near midnight.
// - **Earshot's rules, computed from the call's local date:**
//   - A bare weekday ("by Friday", "this Friday") is the first one after the call. chrono's
//     closest-day rule gives today for the call's own weekday, or a week later, depending on the
//     hour; Earshot always means a week later.
//   - "next Friday" has two readings, the coming Friday and the one after: speakers disagree.
//     "Friday next week" has one, the Friday of the week after the call's (weeks start Monday).
//   - The end of the week is its Friday (EOW); of the month, its last day (EOM); of the quarter,
//     the calendar quarter's last day (EOQ); of the year, December 31 (EOY). "end of next week"
//     and the like move one period on; "end of Q1" is the next quarter by that name. EOD (end of
//     the day, close of business) is today, unless the quote names a day too ("EOD Friday").
//   - A month and day with no year is the next one on or after the call's date.
//   - "the 15th" (a day of the month alone) is the next 15th on or after the call's date.
//   - A weekday said with a date ("Friday the 27th") must agree with it; if it doesn't, both
//     readings stand.
//   - A period with no day ("next week", "in December", "in a couple of weeks", "Q1") isn't
//     certain: its reading is a guess.
import { casual, type ParsedResult, ReferenceWithTimezone } from "chrono-node/en";

/** What a date quote says, resolved against the call. */
export interface DateResolution {
  /**
   * `YYYY-MM-DD`, in the rep's time zone: one reading, or two or three for an ambiguous quote
   * ("next Friday", "Tuesday or Wednesday").
   */
  readonly readings: readonly string[];
  /**
   * Whether the words pin each reading to a day. False for a period ("next week", "in December"),
   * whose reading is only a guess at the day.
   */
  readonly certain: boolean;
  /** Relative to the call ("by Friday", "tomorrow", "in two weeks"), not a named date. */
  readonly relative: boolean;
}

/** A date expression found in a text, and where. */
export interface DateExpression extends DateResolution {
  /** `[start, end)` in the text. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A time quote's readings, `HH:MM`, 24-hour. */
export interface TimeResolution {
  /** One reading, or two when "at 3" could be morning or afternoon (the likelier first). */
  readonly readings: readonly string[];
  /** Whether the words say the hour (false for "this afternoon"). */
  readonly certain: boolean;
}

const DAY_MS = 86_400_000;

/** A calendar day as days since 1970-01-01, for arithmetic without time zones. */
type Day = number;

function dayOf(year: number, month: number, date: number): Day {
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

function partsOf(day: Day): { year: number; month: number; date: number; weekday: number } {
  const at = new Date(day * DAY_MS);
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    date: at.getUTCDate(),
    weekday: at.getUTCDay(),
  };
}

function isoOf(day: Day): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function lastOfMonth(year: number, month: number): Day {
  return dayOf(year, month + 1, 0);
}

// ─── The call's clock, from Intl ─────────────────────────────────────────────────────────────

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    FORMATTERS.set(timeZone, found);
  }
  return found;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly date: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    year: get("year"),
    month: get("month"),
    date: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetFromClock(instant: Date, clock: WallClock): number {
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.date,
    clock.hour,
    clock.minute,
    clock.second,
  );
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/**
 * The time zone's UTC offset at an instant, in minutes east of UTC, as chrono's reference takes
 * it: -300 for Chicago in summer, -360 in winter. From `Intl`, because chrono reads no IANA names.
 */
export function timeZoneOffset(instant: Date, timeZone: string): number {
  return offsetFromClock(instant, wallClock(instant, timeZone));
}

function instantOf(callTime: string | Date): Date {
  const instant = new Date(typeof callTime === "string" ? callTime : callTime.getTime());
  if (Number.isNaN(instant.getTime())) throw new RangeError(`not a timestamp: ${String(callTime)}`);
  return instant;
}

/** The call's calendar date in the rep's time zone, `YYYY-MM-DD`. */
export function callDate(callTime: string | Date, timeZone: string): string {
  const clock = wallClock(instantOf(callTime), timeZone);
  return isoOf(dayOf(clock.year, clock.month, clock.date));
}

function localMidnight(day: Day, timeZone: string): number {
  const guess = day * DAY_MS;
  let at = guess - timeZoneOffset(new Date(guess), timeZone) * 60_000;
  at = guess - timeZoneOffset(new Date(at), timeZone) * 60_000;
  return at;
}

/**
 * Whether the time zone's offset changes during a local calendar day (`YYYY-MM-DD`): a
 * daylight-saving change, such as 2026-11-01 in America/Chicago. A meeting time on such a day is
 * flagged (faithfulness.ts).
 */
export function offsetChangesOn(date: string, timeZone: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const day = dayOf(Number(match[1]), Number(match[2]), Number(match[3]));
  const start = localMidnight(day, timeZone);
  const end = localMidnight(day + 1, timeZone);
  return timeZoneOffset(new Date(start), timeZone) !== timeZoneOffset(new Date(end - 1), timeZone);
}

interface CallContext {
  readonly instant: Date;
  readonly offset: number;
  readonly today: Day;
  readonly year: number;
  readonly month: number;
  readonly weekday: number;
  /**
   * Intl's local date less chrono's: chrono computes relative days from a `Date` moved into the
   * system's time zone, which can land on another day if the system's own offset changes in
   * between. Zero in practice (workerd runs in UTC); its days are shifted by it either way.
   */
  readonly skew: number;
}

function callContext(callTime: string | Date, timeZone: string): CallContext {
  const instant = instantOf(callTime);
  const clock = wallClock(instant, timeZone);
  const offset = offsetFromClock(instant, clock);
  const today = dayOf(clock.year, clock.month, clock.date);
  const shifted = new ReferenceWithTimezone(instant, offset).getDateWithAdjustedTimezone();
  const chronoToday = dayOf(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
  return {
    instant,
    offset,
    today,
    year: clock.year,
    month: clock.month,
    weekday: partsOf(today).weekday,
    skew: today - chronoToday,
  };
}

// ─── Earshot's rules ─────────────────────────────────────────────────────────────────────────

type ExpressionKind = "weekday" | "date" | "eod" | "other";

interface Found {
  readonly start: number;
  readonly end: number;
  readonly days: readonly Day[];
  readonly certain: boolean;
  readonly relative: boolean;
  readonly kind: ExpressionKind;
  /** For a weekday expression, the weekday named (0 is Sunday). */
  readonly weekday?: number;
}

type Resolved = Omit<Found, "start" | "end">;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_PATTERN = WEEKDAYS.join("|");
const COUNT_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** The first `weekday` after the call: 1 to 7 days on. */
function firstAfter(context: CallContext, weekday: number): Day {
  return context.today + ((weekday - context.weekday + 7) % 7 || 7);
}

/** `weekday` in the week `weeks` from the call's (weeks start Monday). */
function inWeek(context: CallContext, weeks: number, weekday: number): Day {
  const monday = context.today - ((context.weekday + 6) % 7);
  return monday + 7 * weeks + ((weekday + 6) % 7);
}

/** The last `weekday` before the call: 1 to 7 days back. */
function lastBefore(context: CallContext, weekday: number): Day {
  return context.today - ((context.weekday - weekday + 7) % 7 || 7);
}

/** The end of the call's week: Friday, today if it's Friday, the coming one at a weekend. */
function endOfWeek(context: CallContext): Day {
  return context.today + ((5 - context.weekday + 7) % 7);
}

function endOfQuarter(year: number, quarter: number): Day {
  return lastOfMonth(year, quarter * 3);
}

/** The next `month`/`date` on or after the call's date, skipping years without it (Feb 29). */
function nextOccurrence(context: CallContext, month: number, date: number): Day | null {
  for (let year = context.year; year <= context.year + 8; year += 1) {
    const day = dayOf(year, month, date);
    if (partsOf(day).month !== month) continue;
    if (day >= context.today) return day;
  }
  return null;
}

/** The next day-of-month `date` on or after the call's date, skipping months without it. */
function nextDayOfMonth(context: CallContext, date: number): Day | null {
  for (let k = 0; k <= 12; k += 1) {
    const day = dayOf(context.year, context.month + k, date);
    if (partsOf(day).date === date && day >= context.today) return day;
  }
  return null;
}

function single(day: Day, kind: ExpressionKind = "other", certain = true): Resolved {
  return { days: [day], certain, relative: true, kind };
}

interface Rule {
  readonly pattern: RegExp;
  readonly resolve: (match: RegExpExecArray, context: CallContext) => Resolved | null;
}

/** `count` days, weeks, or months after a day; a month on keeps the day, or the month's last. */
function addUnits(from: Day, count: number, unit: string): Day {
  if (unit === "day") return from + count;
  if (unit === "week") return from + 7 * count;
  const parts = partsOf(from);
  const { year, month } = partsOf(dayOf(parts.year, parts.month + count, 1));
  return Math.min(dayOf(year, month, parts.date), lastOfMonth(year, month));
}

/**
 * Earshot's rules, tried before chrono, in order. The text a rule consumes is hidden from chrono
 * and from later rules: chrono reads "end of the week" as "the week", a week from today.
 */
const RULES: readonly Rule[] = [
  {
    pattern: /\bend\s+of\s+next\s+week\b/giu,
    resolve: (_, context) => single(endOfWeek(context) + 7),
  },
  {
    pattern: /\bend\s+of\s+next\s+month\b/giu,
    resolve: (_, context) => single(lastOfMonth(context.year, context.month + 1)),
  },
  {
    pattern: /\bend\s+of\s+next\s+quarter\b/giu,
    resolve: (_, context) => {
      const quarter = Math.ceil(context.month / 3) + 1;
      return single(
        endOfQuarter(context.year + Math.floor((quarter - 1) / 4), ((quarter - 1) % 4) + 1),
      );
    },
  },
  {
    pattern: /\bend\s+of\s+next\s+year\b/giu,
    resolve: (_, context) => single(dayOf(context.year + 1, 12, 31)),
  },
  {
    pattern: /\b(?:eow|end\s+of\s+(?:the\s+|this\s+)?(?:work\s*)?week)\b/giu,
    resolve: (_, context) => single(endOfWeek(context)),
  },
  {
    pattern: /\b(?:eom|end\s+of\s+(?:the\s+|this\s+)?month|month[-\s]end)\b/giu,
    resolve: (_, context) => single(lastOfMonth(context.year, context.month)),
  },
  {
    pattern: /\bend\s+of\s+(?:the\s+)?q([1-4])\b/giu,
    resolve: (match, context) => {
      const quarter = Number(match[1]);
      const end = endOfQuarter(context.year, quarter);
      return single(end >= context.today ? end : endOfQuarter(context.year + 1, quarter));
    },
  },
  {
    pattern: /\b(?:eoq|end\s+of\s+(?:the\s+|this\s+)?quarter|quarter[-\s]end)\b/giu,
    resolve: (_, context) => single(endOfQuarter(context.year, Math.ceil(context.month / 3))),
  },
  {
    pattern: /\b(?:eoy|end\s+of\s+(?:the\s+|this\s+)?year|year[-\s]end)\b/giu,
    resolve: (_, context) => single(dayOf(context.year, 12, 31)),
  },
  {
    pattern:
      /\b(?:eod|cob|eob|end\s+of\s+(?:the\s+)?(?:business\s+)?day|end\s+of\s+business|close\s+of\s+business|end\s+of\s+today)\b/giu,
    resolve: (_, context) => single(context.today, "eod"),
  },
  {
    pattern: /\b(?:the\s+)?day\s+after\s+tomorrow\b/giu,
    resolve: (_, context) => single(context.today + 2),
  },
  {
    pattern: /\b(?:in\s+)?(?:a|one)\s+fortnight\b/giu,
    resolve: (_, context) => single(context.today + 14),
  },
  {
    pattern:
      /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(day|week|month)s?\s+from\s+(today|now|tomorrow)\b/giu,
    resolve: (match, context) => {
      const count = COUNT_WORDS[(match[1] ?? "").toLowerCase()] ?? Number(match[1]);
      const from =
        (match[3] ?? "").toLowerCase() === "tomorrow" ? context.today + 1 : context.today;
      return single(addUnits(from, count, (match[2] ?? "").toLowerCase()));
    },
  },
  {
    pattern: /\b(?:the\s+)?week\s+after\s+next\b/giu,
    resolve: (_, context) => single(context.today + 14, "other", false),
  },
  {
    pattern: new RegExp(`\\bnext\\s+week,?\\s+(?:on\\s+)?(${WEEKDAY_PATTERN})\\b`, "giu"),
    resolve: (match, context) => {
      const weekday = WEEKDAYS.indexOf((match[1] ?? "").toLowerCase());
      return { ...single(inWeek(context, 1, weekday), "weekday"), weekday };
    },
  },
  {
    pattern: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(the|this|next)\s+month\b/giu,
    resolve: (match, context) => {
      const date = Number(match[1]);
      const month = context.month + ((match[2] ?? "").toLowerCase() === "next" ? 1 : 0);
      const day = dayOf(context.year, month, date);
      // No such day that month: "the 31st of next month" in a 30-day month.
      if (date < 1 || partsOf(day).date !== date) return null;
      return { days: [day], certain: true, relative: true, kind: "date" };
    },
  },
  {
    // A quarter with no day ("by Q1"): its last day, as a guess.
    pattern: /\bq([1-4])\b/giu,
    resolve: (match, context) => {
      const quarter = Number(match[1]);
      const end = endOfQuarter(context.year, quarter);
      const day = end >= context.today ? end : endOfQuarter(context.year + 1, quarter);
      return { days: [day], certain: false, relative: false, kind: "other" };
    },
  },
];

/** "the 15th": a day of the month with no month named. */
const DAY_OF_MONTH = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/giu;

// ─── chrono's results ────────────────────────────────────────────────────────────────────────

type Components = ParsedResult["start"];

/** A period with no day: "next week", "this month", "the coming quarter". */
const PERIOD = /\b(?:this|next|last|past|coming)\s+(?:week|month|quarter|year)\b/u;
/** A vague count: "in a couple of weeks", "a few days". */
const VAGUE = /\b(?:couple|few|several|some)\b/u;
const NEXT_WEEK_POSTFIX = /\b(?:of\s+)?next\s+week\b/u;
const THIS_WEEK_POSTFIX = /\b(?:of\s+)?this\s+week\b/u;
const LAST_WEEK_POSTFIX = /\b(?:of\s+)?(?:last|past)\s+week\b/u;
const NEXT_PREFIX = /^(?:on\s+)?next\b/u;
const LAST_PREFIX = /^(?:on\s+)?(?:last|past)\b/u;

function isRelativeResult(result: ParsedResult): boolean {
  for (const tag of result.tags()) {
    if (tag === "result/relativeDate" || tag.startsWith("casualReference/")) return true;
  }
  return false;
}

function chronoDay(components: Components, context: CallContext): Day {
  return (
    dayOf(components.get("year") ?? 0, components.get("month") ?? 1, components.get("day") ?? 1) +
    context.skew
  );
}

/** The days a weekday expression names, by its modifier. */
function weekdayDays(context: CallContext, weekday: number, text: string): Day[] {
  if (NEXT_WEEK_POSTFIX.test(text)) return [inWeek(context, 1, weekday)];
  if (THIS_WEEK_POSTFIX.test(text)) return [inWeek(context, 0, weekday)];
  if (LAST_WEEK_POSTFIX.test(text)) return [inWeek(context, -1, weekday)];
  if (LAST_PREFIX.test(text)) return [lastBefore(context, weekday)];
  const coming = firstAfter(context, weekday);
  if (NEXT_PREFIX.test(text)) return [coming, coming + 7];
  return [coming];
}

function resolveComponents(
  components: Components,
  result: ParsedResult,
  text: string,
  context: CallContext,
): Resolved | null {
  const weekday = components.get("weekday");
  if (
    components.isCertain("weekday") &&
    weekday !== null &&
    !components.isCertain("day") &&
    !components.isCertain("month")
  ) {
    // "weekend" (Saturday, to chrono) and "weekday" are spans of days, not days.
    const span = /\bweek(?:end|day)\b/u.test(text);
    return {
      days: weekdayDays(context, weekday, text),
      certain: !span,
      relative: true,
      kind: "weekday",
      weekday,
    };
  }
  const relative = isRelativeResult(result);
  if (components.isCertain("day") && components.isCertain("month")) {
    if (relative) {
      return {
        days: [chronoDay(components, context)],
        certain: !PERIOD.test(text) && !VAGUE.test(text),
        relative: true,
        kind: "other",
      };
    }
    const month = components.get("month") ?? 1;
    const date = components.get("day") ?? 1;
    const named = components.isCertain("year")
      ? dayOf(components.get("year") ?? context.year, month, date)
      : nextOccurrence(context, month, date);
    if (named === null) return null;
    const days = [named];
    // A weekday that contradicts its date ("Thursday, December 4th" when the 4th is a Friday).
    if (components.isCertain("weekday") && weekday !== null && partsOf(named).weekday !== weekday) {
      days.push(firstAfter(context, weekday));
    }
    return { days, certain: true, relative: false, kind: "date" };
  }
  if (components.isCertain("month")) {
    // A month with no day ("in December", "next month"): a guess at the day.
    return { days: [chronoDay(components, context)], certain: false, relative, kind: "other" };
  }
  // A time with no date ("by 3pm", "this afternoon"): today, or tomorrow once it has passed. A
  // period chrono reads with no certain part ("next quarter") is a guess.
  return {
    days: [chronoDay(components, context)],
    certain: !PERIOD.test(text) && !VAGUE.test(text),
    relative: true,
    kind: "other",
  };
}

function resolveResult(result: ParsedResult, text: string, context: CallContext): Resolved | null {
  const start = resolveComponents(result.start, result, text, context);
  if (start === null || !result.end) return start;
  // A range ("Tuesday to Thursday", "December 4 to 6"): its ends are two readings.
  const end = resolveComponents(result.end, result, text.replace(NEXT_PREFIX, ""), context);
  const first = start.days[0];
  if (end === null || first === undefined) return start;
  const days = end.days.map((day) => (start.kind === "weekday" && day < first ? day + 7 : day));
  return { ...start, days: [...start.days, ...days], certain: start.certain && end.certain };
}

// ─── Putting them together ───────────────────────────────────────────────────────────────────

function trimmed(text: string, start: number, end: number): [number, number] {
  let from = start;
  let to = end;
  while (from < to && !/[\p{L}\p{N}]/u.test(text.charAt(from))) from += 1;
  while (to > from && !/[\p{L}\p{N}]/u.test(text.charAt(to - 1))) to -= 1;
  return [from, to];
}

function overlapsAny(spans: readonly (readonly [number, number])[], start: number, end: number) {
  return spans.some(([from, to]) => start < to && from < end);
}

function mask(text: string, spans: readonly (readonly [number, number])[]): string {
  let out = text;
  for (const [start, end] of spans) {
    out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
  }
  return out;
}

function unique(days: readonly Day[]): Day[] {
  return [...new Set(days)];
}

/**
 * A weekday said next to a date names that date, if they agree: "next Friday the 27th" is the
 * 27th; "Friday, the 5th", when the 5th is a Saturday, keeps both readings.
 */
function mergeWeekdayWithDate(found: readonly Found[], text: string): Found[] {
  const out: Found[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const current = found[index];
    const next = found[index + 1];
    if (!current) continue;
    if (
      next &&
      current.kind === "weekday" &&
      current.weekday !== undefined &&
      next.kind === "date" &&
      /^[\s,]*$/u.test(text.slice(current.end, next.start))
    ) {
      const agreeing = next.days.filter((day) => partsOf(day).weekday === current.weekday);
      out.push({
        ...next,
        start: current.start,
        days: agreeing.length > 0 ? agreeing : unique([...current.days, ...next.days]),
      });
      index += 1;
      continue;
    }
    out.push(current);
  }
  return out;
}

/**
 * Every date expression in a text, in order, each resolved against the call (`callTime`, an
 * instant, in the rep's IANA `timeZone`). Throws a `RangeError` for an invalid instant or zone.
 */
export function findDates(
  text: string,
  callTime: string | Date,
  timeZone: string,
): DateExpression[] {
  const context = callContext(callTime, timeZone);
  const found: Found[] = [];
  const taken: [number, number][] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsAny(taken, start, end)) continue;
      const resolved = rule.resolve(match, context);
      if (resolved === null) continue;
      taken.push([start, end]);
      found.push({ ...resolved, start, end });
    }
  }

  const results = casual.parse(
    mask(text, taken),
    { instant: context.instant, timezone: context.offset },
    { forwardDate: true },
  );
  for (const result of results) {
    const [start, end] = trimmed(text, result.index, result.index + result.text.length);
    if (start >= end) continue;
    const resolved = resolveResult(result, text.slice(start, end).toLowerCase(), context);
    if (resolved === null) continue;
    taken.push([start, end]);
    found.push({ ...resolved, start, end });
  }

  for (const match of text.matchAll(DAY_OF_MONTH)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsAny(taken, start, end)) continue;
    const day = nextDayOfMonth(context, Number(match[1]));
    if (day === null) continue;
    found.push({ days: [day], certain: true, relative: true, kind: "date", start, end });
  }

  found.sort((left, right) => left.start - right.start);
  const merged = mergeWeekdayWithDate(found, text);
  // EOD next to a day adds nothing to it: "EOD Friday", "end of day on Friday", "Friday EOD".
  const beside = (left: Found | undefined, right: Found | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.kind !== right.kind &&
    /^[\s,]*(?:on\s+|by\s+)?$/iu.test(text.slice(left.end, right.start));
  const kept = merged.filter(
    (item, index) =>
      item.kind !== "eod" || !(beside(item, merged[index + 1]) || beside(merged[index - 1], item)),
  );
  return kept.map((item) => ({
    readings: unique(item.days).map(isoOf),
    certain: item.certain,
    relative: item.relative,
    start: item.start,
    end: item.end,
    text: text.slice(item.start, item.end),
  }));
}

/**
 * What a quoted date says, resolved against the call time in the rep's time zone (spec WP7 step
 * 1): `{ readings, certain, relative }`. A quote with several date expressions has all their
 * readings, up to three; more is no reading. Null when the quote names no date. Throws a
 * `RangeError` for an invalid instant or zone.
 */
export function resolveDate(
  quote: string,
  callTime: string | Date,
  timeZone: string,
): DateResolution | null {
  const found = findDates(quote, callTime, timeZone);
  if (found.length === 0) return null;
  const readings = [...new Set(found.flatMap((item) => item.readings))];
  if (readings.length > 3) return null;
  return {
    readings,
    certain: found.every((item) => item.certain),
    relative: found.some((item) => item.relative),
  };
}

// ─── Times ───────────────────────────────────────────────────────────────────────────────────

/** Any instant does: a time's reading doesn't depend on the day. */
const TIME_REFERENCE = new Date(Date.UTC(2026, 0, 15, 12));

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** chrono's components of one end of a parsed expression (`chrono-node/en` doesn't name the type). */
type ParsedComponents = ParsedResult["start"];

/** One parsed time's readings, or null when it names no hour (or only a vague part of day). */
function timeOf(components: ParsedComponents, text: string): TimeResolution | null {
  const hour = components.get("hour");
  if (hour === null) return null;
  const minute = components.get("minute") ?? 0;
  if (!components.isCertain("hour")) {
    if (!/\b(?:morning|noon|afternoon|evening|tonight|night|midnight)\b/iu.test(text)) {
      return null;
    }
    return { readings: [hhmm(hour, minute)], certain: false };
  }
  if (
    components.isCertain("meridiem") ||
    hour === 0 ||
    hour > 12 ||
    /\b(?:noon|midday)\b/iu.test(text)
  ) {
    return { readings: [hhmm(hour, minute)], certain: true };
  }
  const morning = hhmm(hour % 12, minute);
  const afternoon = hhmm((hour % 12) + 12, minute);
  if (hour === 12) return { readings: [hhmm(12, minute), hhmm(0, minute)], certain: true };
  return { readings: hour >= 7 ? [morning, afternoon] : [afternoon, morning], certain: true };
}

/**
 * What a quoted time says, `HH:MM` (for the `meeting` type's `time` field): "3pm" is 15:00; "at
 * 3" could be either, so it has two readings, the business-hours one first (7 to 11 in the
 * morning, 12 to 6 in the afternoon). A quote that names more than one time ("3pm or 4pm", "from
 * 3pm to 4pm") has every reading, in order, so no single one can replace the model's value. Null
 * when the quote names no time.
 */
export function resolveTime(quote: string): TimeResolution | null {
  const found: TimeResolution[] = [];
  for (const result of casual.parse(quote, { instant: TIME_REFERENCE, timezone: 0 })) {
    for (const components of [result.start, result.end]) {
      const time = components ? timeOf(components, result.text) : null;
      if (time) found.push(time);
    }
  }
  if (found.length === 0) return null;
  return {
    readings: [...new Set(found.flatMap((time) => time.readings))],
    certain: found.every((time) => time.certain),
  };
}
