// Checks on the ground truth itself, so a wrong expected value can't hide in 30 hand-written
// files: every date field is re-derived from its quote and the call time, every amount from its
// quote. The resolvers cover the phrasings the scripts use, not English in general; a phrase they
// don't know fails the coverage test rather than passing unchecked.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
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
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** A calendar day as a UTC midnight timestamp, for day arithmetic without time zones. */
type Day = number;
const DAY_MS = 86_400_000;

function day(year: number, month: number, date: number): Day {
  return Date.UTC(year, month - 1, date);
}

function isoDay(value: Day): string {
  return new Date(value).toISOString().slice(0, 10);
}

/** The call's calendar date in the rep's time zone, as `YYYY-MM-DD`. */
export function localDate(callTime: string, timeZone: string): string {
  const at = new Date(callTime);
  if (Number.isNaN(at.getTime())) throw new RangeError(`not a timestamp: ${callTime}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseIsoDay(iso: string): Day {
  const [year, month, date] = iso.split("-").map(Number);
  return day(year ?? 0, month ?? 0, date ?? 0);
}

function lastDayOfMonth(year: number, month: number): Day {
  return day(year, month + 1, 0);
}

function countWord(word: string): number | undefined {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "a" || word === "an") return 1;
  return SMALL_NUMBERS[word];
}

export interface ResolvedDate {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Relative to the call ("by Thursday", "tomorrow"), rather than a named date. */
  readonly relative: boolean;
}

/**
 * The date a quoted phrase names, resolved against the call's local date the way the extraction
 * prompt tells the model to: a bare weekday is the first one after the call ("by Thursday").
 * Null for a phrase it doesn't know, and for ambiguous ones such as "next Friday".
 */
export function resolveDatePhrase(
  quote: string,
  callTime: string,
  timeZone: string,
): ResolvedDate | null {
  const today = parseIsoDay(localDate(callTime, timeZone));
  const now = new Date(today);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const weekday = now.getUTCDay();
  const relative = (value: Day): ResolvedDate => ({ date: isoDay(value), relative: true });

  let phrase = trimTrailingPunctuation(quote.toLowerCase()).replace(/\s+/g, " ").trim();
  phrase = phrase.replace(/^(?:by|on|for|due)\s+/u, "");

  if (phrase === "today") return relative(today);
  if (phrase === "tomorrow") return relative(today + DAY_MS);

  const named = /^(?:this\s+(?:coming\s+)?)?([a-z]+)$/u.exec(phrase);
  const weekdayIndex = named ? WEEKDAYS.indexOf(named[1] ?? "") : -1;
  if (weekdayIndex >= 0) {
    const ahead = (weekdayIndex - weekday + 7) % 7 || 7;
    return relative(today + ahead * DAY_MS);
  }

  const span = /^in\s+([a-z]+|\d+)\s+(days?|weeks?)$/u.exec(phrase);
  if (span) {
    const count = countWord(span[1] ?? "");
    if (count === undefined) return null;
    return relative(today + count * (span[2]?.startsWith("week") ? 7 : 1) * DAY_MS);
  }

  const fromToday = /^([a-z]+|\d+)\s+weeks?\s+from\s+today$/u.exec(phrase);
  if (fromToday) {
    const count = countWord(fromToday[1] ?? "");
    if (count === undefined) return null;
    return relative(today + count * 7 * DAY_MS);
  }

  if (/^(?:the\s+)?end\s+of\s+(?:the|this)\s+week$/u.test(phrase)) {
    return relative(today + ((5 - weekday + 7) % 7) * DAY_MS);
  }
  if (/^(?:the\s+)?end\s+of\s+(?:the|this)\s+month$/u.test(phrase)) {
    return relative(lastDayOfMonth(year, month));
  }
  if (/^(?:the\s+)?end\s+of\s+next\s+month$/u.test(phrase)) {
    return relative(lastDayOfMonth(year, month + 1));
  }

  const dated = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/u.exec(phrase);
  const monthIndex = dated ? MONTHS.indexOf(dated[1] ?? "") : -1;
  if (dated && monthIndex >= 0) {
    const date = Number(dated[2]);
    let candidate = day(year, monthIndex + 1, date);
    if (new Date(candidate).getUTCDate() !== date) return null;
    if (candidate < today) candidate = day(year + 1, monthIndex + 1, date);
    return { date: isoDay(candidate), relative: false };
  }
  return null;
}

/**
 * The US-dollar amount a quote names: digits (`$45,000`, `45k`, `1.2 million`) or words
 * (`one hundred eighty-five thousand`, `a hundred and twenty thousand`), with or without
 * "dollars". Null for anything else.
 */
export function parseUsd(quote: string): number | null {
  const text = quote
    .toLowerCase()
    .replace(/\bdollars?\b/gu, "")
    .replace(/[$,]/gu, "")
    .trim();
  const digits = /^(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?$/u.exec(text);
  if (digits) {
    const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[digits[2] ?? ""] ?? 1;
    const value = Math.round(Number(digits[1]) * scale * 100) / 100;
    return Number.isFinite(value) ? value : null;
  }
  const words = text.split(/[\s-]+/u).filter((word) => word !== "" && word !== "and");
  if (words.length === 0) return null;
  let total = 0;
  let group = 0;
  let sawNumber = false;
  for (const [index, word] of words.entries()) {
    const next = words[index + 1];
    if ((word === "a" || word === "an") && next && /^(?:hundred|thousand|million)$/u.test(next)) {
      group += 1;
      continue;
    }
    const small = SMALL_NUMBERS[word];
    if (small !== undefined) {
      group += small;
      sawNumber = true;
    } else if (word === "hundred") {
      group = (group || 1) * 100;
    } else if (word === "thousand") {
      total += (group || 1) * 1_000;
      group = 0;
    } else if (word === "million") {
      total += (group || 1) * 1_000_000;
      group = 0;
    } else {
      return null;
    }
  }
  return sawNumber || total > 0 ? total + group : null;
}

/**
 * The time of day a quoted phrase names, `HH:MM` on a 24-hour clock: "at 2 pm", "10:30 a.m.",
 * "at noon". Null for anything else, a bare "at 3" included: it could be either, and the
 * scripts only use times with their half of the day said.
 */
export function resolveTimePhrase(quote: string): string | null {
  const words = trimTrailingPunctuation(quote.toLowerCase()).split(/\s+/).filter(Boolean);
  if (words[0] === "at") words.shift();
  if (words.length === 1 && (words[0] === "noon" || words[0] === "midday")) return "12:00";
  const clock = words[0] ?? "";
  const half = (words[1] ?? "").replaceAll(".", "");
  if (words.length !== 2 || (half !== "am" && half !== "pm")) return null;
  const [hourText, minuteText = "00", ...rest] = clock.split(":");
  if (rest.length > 0 || !/^\d{1,2}$/.test(hourText ?? "") || !/^\d{2}$/.test(minuteText)) {
    return null;
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const hour24 = (hour % 12) + (half === "pm" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${minuteText}`;
}

/** The negations `@earshot/agent`'s risk flags look for. */
export const NEGATION_PATTERN =
  /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|\w+n't)\b/iu;

/** How a rep takes back what they just said. */
export const CORRECTION_MARKER =
  /\b(?:sorry|actually|no wait|i mean|scratch that|make that|correction)\b/iu;

/** Digits or a number word ("one" is too common to count). */
export const NUMBER_PATTERN =
  /\d|\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|percent)\b/iu;

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/** Drops trailing `.,;:!?` by scanning back once; a regex like /[.,;:!?]+$/ backtracks on long runs. */
function trimTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}
