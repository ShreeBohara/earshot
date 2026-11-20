// The value phrases the generator says (Phase 4 WP10 step 2): dates, amounts, times, emails, and
// phones. Each comes with its value, which the ground truth re-derives from the words with the
// evals' own resolvers (src/verify.ts), never the product's (spec decision 13). A phrase is said
// once (`said`, what the renderer speaks) and may be written another way by the speech-to-text
// streams (`heard`: digits for an amount, as a stream writes them).
import type { Rng } from "../channel/rng";
import { localDate, parseUsd, resolveDatePhrase, resolveTimePhrase } from "../verify";

export interface ValuePhrase<V extends string | number> {
  /** The words as said. */
  readonly said: string;
  /** The words as both streams write them. */
  readonly heard: string;
  readonly value: V;
}

/** What a date resolves against: the call, in the rep's time zone. */
export interface CallContext {
  readonly callTime: string;
  readonly timeZone: string;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const DAY_MS = 86_400_000;

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** "December 4th": the date `daysAhead` days after the call's local date. */
function absoluteDay(ctx: CallContext, daysAhead: number): string {
  const today = Date.parse(`${localDate(ctx.callTime, ctx.timeZone)}T00:00:00Z`);
  const date = new Date(today + daysAhead * DAY_MS);
  return `${MONTHS[date.getUTCMonth()]} ${ordinal(date.getUTCDate())}`;
}

function datePhrase(said: string, ctx: CallContext): ValuePhrase<string> {
  const resolved = resolveDatePhrase(said, ctx.callTime, ctx.timeZone);
  if (resolved === null) throw new Error(`the generator said a date it can't resolve: "${said}"`);
  return { said, heard: said, value: resolved.date };
}

const SPANS = [
  "in three days",
  "in ten days",
  "in two weeks",
  "in three weeks",
  "a week from today",
  "two weeks from today",
] as const;

/** When a task or commitment is due: a relative phrase most of the time, else a dated one. */
export function duePhrase(rng: Rng, ctx: CallContext): ValuePhrase<string> {
  const kind = rng.weighted({
    weekday: 0.45,
    tomorrow: 0.1,
    span: 0.15,
    period: 0.12,
    dated: 0.18,
  });
  switch (kind) {
    case "weekday":
      return datePhrase(`${rng.pick(["by ", "by ", "on ", ""])}${rng.pick(WEEKDAYS)}`, ctx);
    case "tomorrow":
      return datePhrase(rng.pick(["tomorrow", "by tomorrow"]), ctx);
    case "span":
      return datePhrase(rng.pick(SPANS), ctx);
    case "period":
      return datePhrase(
        rng.pick(["by the end of the week", "by the end of the month", "by the end of next month"]),
        ctx,
      );
    default:
      return datePhrase(`by ${absoluteDay(ctx, rng.int(5, 45))}`, ctx);
  }
}

/** A deal's close date, said after "to", "is now", "by", or "closing": dated, or a month's end. */
export function closePhrase(rng: Rng, ctx: CallContext): ValuePhrase<string> {
  if (rng.chance(0.25)) {
    return datePhrase(rng.pick(["the end of the month", "the end of next month"]), ctx);
  }
  return datePhrase(absoluteDay(ctx, rng.int(10, 75)), ctx);
}

/** The day a meeting is on. */
export function dayPhrase(rng: Rng, ctx: CallContext): ValuePhrase<string> {
  const kind = rng.weighted({ weekday: 0.6, tomorrow: 0.15, dated: 0.25 });
  if (kind === "weekday")
    return datePhrase(`${rng.pick(["on ", "on ", ""])}${rng.pick(WEEKDAYS)}`, ctx);
  if (kind === "tomorrow") return datePhrase("tomorrow", ctx);
  return datePhrase(`on ${absoluteDay(ctx, rng.int(3, 30))}`, ctx);
}

/**
 * A date said instead of `phrase`, for a self-correction: another weekday for a weekday, another
 * day for a dated phrase; null for phrases a rep doesn't correct that way ("tomorrow", "in two
 * weeks"). The replacement is said bare ("Friday", "December 5th"), as reps do after a marker.
 */
export function dateCorrection(
  phrase: ValuePhrase<string>,
  rng: Rng,
  ctx: CallContext,
): { retracted: string; replacement: ValuePhrase<string> } | null {
  const words = phrase.said.split(" ");
  const last = words.at(-1) ?? "";
  const weekday = WEEKDAYS.find((day) => day === last);
  if (weekday) {
    const other = rng.pick(WEEKDAYS.filter((day) => day !== weekday));
    // The rep said the other day first, then the one the ground truth holds.
    return {
      retracted: [...words.slice(0, -1), other].join(" "),
      replacement: datePhrase(weekday, ctx),
    };
  }
  const month = MONTHS.find((name) => words.includes(name));
  if (!month) return null;
  const bare = words.slice(words.indexOf(month)).join(" ");
  const resolved = resolveDatePhrase(bare, ctx.callTime, ctx.timeZone);
  if (resolved === null) return null;
  const shift = rng.pick([-2, -1, 1, 2]);
  const today = Date.parse(`${localDate(ctx.callTime, ctx.timeZone)}T00:00:00Z`);
  const ahead = Math.round((Date.parse(`${resolved.date}T00:00:00Z`) - today) / DAY_MS) + shift;
  if (ahead < 2) return null;
  const retracted = [...words.slice(0, words.indexOf(month)), absoluteDay(ctx, ahead)].join(" ");
  if (retracted.includes(bare)) return null;
  return { retracted, replacement: datePhrase(bare, ctx) };
}

// --- Amounts ---------------------------------------------------------------------------------

const UNITS = [
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

/** 1 to 999 in words, as a rep says them: "one hundred eighty-five". */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new RangeError(`can't say ${n}`);
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${UNITS[hundreds]} hundred`);
  if (rest > 0 && rest < 20) parts.push(UNITS[rest] as string);
  else if (rest >= 20) {
    const unit = rest % 10;
    parts.push(
      unit === 0
        ? (TENS[Math.floor(rest / 10)] as string)
        : `${TENS[Math.floor(rest / 10)]}-${UNITS[unit]}`,
    );
  }
  return parts.join(" ");
}

/** A whole-dollar amount in words: "forty-two thousand", "seven thousand five hundred". */
export function amountWords(value: number): string {
  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;
  if (thousands < 1 || thousands > 999 || (rest !== 0 && rest % 100 !== 0)) {
    throw new RangeError(`can't say $${value}`);
  }
  return rest === 0
    ? `${numberWords(thousands)} thousand`
    : `${numberWords(thousands)} thousand ${numberWords(rest)}`;
}

/** An amount as a stream writes it: "$42,000", or "42,000" when no currency was said. */
function amountDigits(value: number, dollars: boolean): string {
  return `${dollars ? "$" : ""}${value.toLocaleString("en-US")}`;
}

/** A deal amount, said in words; the streams write it in digits about two times in five. */
export function amountPhrase(rng: Rng): ValuePhrase<number> {
  const value =
    rng.weighted({ small: 0.3, mid: 0.5, large: 0.2 }) === "small"
      ? rng.int(10, 39) * 500
      : rng.chance(0.7)
        ? rng.int(20, 150) * 1000
        : rng.int(15, 60) * 5000;
  return amountFor(value, rng);
}

function amountFor(value: number, rng: Rng): ValuePhrase<number> {
  const dollars = rng.chance(0.3);
  const said = `${amountWords(value)}${dollars ? " dollars" : ""}`;
  const heard = rng.chance(0.4) ? amountDigits(value, dollars) : said;
  if (parseUsd(said) !== value || parseUsd(heard) !== value) {
    throw new Error(`the generator said an amount it can't read back: "${said}" / "${heard}"`);
  }
  return { said, heard, value };
}

/**
 * An amount said instead of `phrase`, for a self-correction: a nearby figure, written the way the
 * stream writes the replacement. Null when the replacement's words would occur inside the
 * retracted ones, so the replacement's quote wouldn't be its first occurrence.
 */
export function amountCorrection(
  phrase: ValuePhrase<number>,
  rng: Rng,
): { retracted: ValuePhrase<number> } | null {
  const step = phrase.value >= 20_000 ? 5_000 : 500;
  const other = phrase.value + rng.pick([-2, -1, 1, 2]) * step;
  if (other < 5_000) return null;
  const retracted = amountFor(other, rng);
  const writtenAsDigits = phrase.heard !== phrase.said;
  const retractedHeard = writtenAsDigits
    ? amountDigits(other, phrase.heard.startsWith("$"))
    : retracted.said;
  const result = { said: retracted.said, heard: retractedHeard, value: other };
  if (result.said.includes(phrase.said) || result.heard.includes(phrase.heard)) return null;
  return { retracted: result };
}

// --- Times, emails, phones -------------------------------------------------------------------

/** When a meeting starts, with its half of the day said: "at 2 pm", "at 10:30 am", "at noon". */
export function timePhrase(rng: Rng): ValuePhrase<string> {
  if (rng.chance(0.08)) return checkedTime("at noon");
  const hour = rng.pick([8, 9, 9, 10, 10, 11, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  const half = hour >= 8 && hour <= 11 ? "am" : "pm";
  const minute = rng.pick(["", "", "", ":30", ":15", ":45"]);
  return checkedTime(`at ${hour}${minute} ${half}`);
}

function checkedTime(said: string): ValuePhrase<string> {
  const value = resolveTimePhrase(said);
  if (value === null) throw new Error(`the generator said a time it can't read back: "${said}"`);
  return { said, heard: said, value };
}

/** An email on the company's own `.example` domain, from a person's name. */
export function emailFor(name: string, domain: string): string {
  const local = name
    .toLowerCase()
    .split(" ")
    .map((part) => [...part].filter((char) => char >= "a" && char <= "z").join(""))
    .filter(Boolean)
    .join(".");
  return `${local}@${domain}`;
}

/** A phone number in the demo CRM's fictional 555-01xx range. */
export function phoneFor(rng: Rng): string {
  return `555-01${String(rng.int(0, 99)).padStart(2, "0")}`;
}
