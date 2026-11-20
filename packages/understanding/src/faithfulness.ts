// The faithfulness check (spec §4.3 step 4, WP7): each field's value against the words it quotes,
// by field type, with the normalizers' readings.
//
// | Field type                   | Check                                                         |
// |------------------------------|---------------------------------------------------------------|
// | Names, emails, phones        | Equal to the quote once normalized                            |
// | Dates (and a meeting's time) | The value is among the readings                               |
// | Amounts                      | The value equals the parsed amount                            |
// | Stage (and a job title)      | Verbatim from the quote                                       |
// | Free text                    | Content-word overlap with the turn of at least 0.5 (target)   |
//
// **Decision 12:** a unique, certain reading of a date, time, or amount replaces a model value
// that disagrees with it. The model's value is kept in `norm.llmValue` and the field is flagged
// `value_mismatch`. An ambiguous quote keeps the model's value, lists its readings in
// `norm.readings`, and is flagged `ambiguous_value`. Names, emails, phones, and stages are flagged
// but never replaced: their only "reading" is the transcript's own spelling.
//
// **Corrections** come first. A quote that stops at a value the rep took back ("one hundred
// eighty thousand, sorry, one hundred eighty-five thousand") gets `self_correction`, and
// `value_mismatch` if the model kept the retracted value; nothing is replaced, because the
// quote's own reading is the retracted one. A quote that runs on into the new value is read as
// the new value.
//
// **Negation:** any field whose quote sits in a negation scope gets `negation`, beside the model's
// own reading.
import { foldName, normalizeName } from "./names";
import {
  type CurrencyCode,
  findAmounts,
  findCorrection,
  findDates,
  isNegated,
  offsetChangesOn,
  parseAmount,
  resolveDate,
  resolveTime,
  type ValueFinder,
} from "./normalize";

/**
 * A field value, a JSON scalar: `@earshot/core`'s `FieldValue`. Like the linker's contract types,
 * the shapes shared with the contracts are restated here rather than imported, because importing
 * `@earshot/core` brings its session tickets, whose Web Crypto types a program without the DOM
 * can't resolve; a type test in @earshot/evals checks that both sides stay the same.
 */
export type FieldValue = string | number | boolean | null;

/** `@earshot/core`'s `FieldNorm`: what the normalizers made of a field's quote. */
export interface FieldNorm {
  /** The model's value, kept when a unique deterministic reading replaced it. */
  llmValue?: FieldValue;
  /** Every reading of an ambiguous quote (at most 3). */
  readings?: FieldValue[];
  /** ISO 4217, for an amount whose words name a currency. */
  currency?: string;
}

/** The `RiskKindV2` kinds this check raises. */
export type FieldFlagKind =
  | "self_correction"
  | "value_mismatch"
  | "ambiguous_value"
  | "unsupported"
  | "weak_support"
  | "negation";

/** A flag on one field: `RiskFlagV2`'s shape. */
export interface FieldFlag {
  readonly kind: FieldFlagKind;
  readonly field: string;
}

/** The order flags come in. */
const FLAG_ORDER: readonly FieldFlagKind[] = [
  "self_correction",
  "value_mismatch",
  "ambiguous_value",
  "unsupported",
  "weak_support",
  "negation",
];

/**
 * How a field's value is checked:
 * - `name`, `email`, `phone`: equal to the quote once normalized;
 * - `date`, `time`, `amount`: against the normalizers' readings;
 * - `verbatim`: the value appears word for word in the quote (a deal stage, a job title);
 * - `text`: free text, by content-word overlap with the turn.
 */
export type FieldKind =
  | "name"
  | "email"
  | "phone"
  | "date"
  | "time"
  | "amount"
  | "verbatim"
  | "text";

/** Each proposal type's fields and how they're checked, `meeting` (WP8) included. */
export const FIELD_KINDS: Readonly<Record<string, Readonly<Record<string, FieldKind>>>> = {
  note: { body: "text" },
  task: { title: "text", dueDate: "date" },
  contact: { name: "name", title: "verbatim", company: "name", email: "email", phone: "phone" },
  deal_update: { stage: "verbatim", amount: "amount", closeDate: "date" },
  commitment: { text: "text", counterpart: "name", dueDate: "date" },
  meeting: { title: "text", date: "date", time: "time", attendees: "text" },
};

/** How a proposal type's field is checked; a field the table doesn't know is free text. */
export function fieldKind(type: string, field: string): FieldKind {
  return FIELD_KINDS[type]?.[field] ?? "text";
}

/** Free text needs at least this share of its content words in the turn (target). */
export const WEAK_SUPPORT_THRESHOLD = 0.5;

/** One field to check. */
export interface FieldInput {
  /** The field's name, for its flags. */
  readonly field: string;
  readonly kind: FieldKind;
  /** The model's value. */
  readonly value: FieldValue;
  /** The text of the utterance the quote was found in. */
  readonly utterance: string;
  /** The quote's `[start, end)` in that text: `Evidence.span`. */
  readonly span: readonly [number, number];
}

/** What the check needs to know about the turn. */
export interface CheckContext {
  /** The turn's biased utterances, joined: free text is checked against the whole turn. */
  readonly turnText: string;
  /** The call's instant, and the rep's IANA time zone: dates resolve against them. */
  readonly callTime: string | Date;
  readonly timeZone: string;
  /** For a `time` field, the proposal's date (`YYYY-MM-DD`), if it has one. */
  readonly date?: string | null;
  /** The currency an amount field is kept in: the tool schema's US dollars, unless set. */
  readonly currency?: CurrencyCode;
}

/**
 * What the check concluded:
 * - `supported`: the quote supports the value;
 * - `replaced`: a unique reading replaced the model's value;
 * - `ambiguous`: the quote has several readings, or doesn't pin the day, and the value stands;
 * - `mismatch`: the value disagrees with its quote and stands, flagged;
 * - `unread`: a date, time, or amount quote with no reading of that kind;
 * - `weak`: free text that shares too little with the turn;
 * - `unchecked`: a null value.
 */
export type Verdict =
  | "supported"
  | "replaced"
  | "ambiguous"
  | "mismatch"
  | "unread"
  | "weak"
  | "unchecked";

export interface FieldCheck {
  /** The value to store: the model's, or the unique reading that replaced it. */
  readonly value: FieldValue;
  /** What the normalizers made of the quote, when they had something to say. */
  readonly norm?: FieldNorm;
  /** In `FLAG_ORDER`. */
  readonly flags: readonly FieldFlag[];
  readonly verdict: Verdict;
  /** For free text, the share of its content words found in the turn. */
  readonly overlap?: number;
}

interface Outcome {
  readonly value: FieldValue;
  readonly norm?: FieldNorm;
  readonly flags: readonly FieldFlagKind[];
  readonly verdict: Verdict;
  readonly overlap?: number;
}

// ─── Readings: dates, times, amounts ─────────────────────────────────────────────────────────

interface Reading {
  readonly readings: readonly FieldValue[];
  readonly certain: boolean;
  readonly currency?: CurrencyCode | null;
}

interface Reader {
  /** The readings of some words, or null when they have none. */
  read(text: string): Reading | null;
  /** Where values of this kind sit in an utterance, for the correction check. */
  readonly find: ValueFinder | null;
  /** The value in the form readings take, or null when it can't be one. */
  canonical(value: FieldValue): FieldValue;
}

function dateReader(context: CheckContext): Reader {
  return {
    read: (text) => resolveDate(text, context.callTime, context.timeZone),
    find: (text) => findDates(text, context.callTime, context.timeZone),
    canonical: (value) => (typeof value === "string" ? value.trim() : null),
  };
}

const AMOUNT_READER: Reader = {
  read: (text) => {
    const amount = parseAmount(text);
    return amount === null
      ? null
      : { readings: amount.readings, certain: true, currency: amount.currency };
  },
  // A lone small number ("one more thing") is no amount to correct.
  find: (text) => findAmounts(text).filter((amount) => !amount.bare),
  canonical: (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const number = Number(value.replace(/[$,\s]/gu, ""));
    return value.trim() !== "" && Number.isFinite(number) ? number : null;
  },
};

const TIME_READER: Reader = {
  read: (text) => resolveTime(text),
  find: null,
  canonical: (value) => {
    if (typeof value !== "string") return null;
    const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
    return match ? `${(match[1] ?? "").padStart(2, "0")}:${match[2]}` : null;
  },
};

function among(reader: Reader, value: FieldValue, reading: Reading | null): boolean {
  const canonical = reader.canonical(value);
  return canonical !== null && (reading?.readings.includes(canonical) ?? false);
}

function checkReadings(
  input: FieldInput,
  reader: Reader,
  fieldCurrency: CurrencyCode | null,
): Outcome {
  const { utterance, span, value } = input;
  const slice = (range: readonly [number, number]) => utterance.slice(range[0], range[1]);
  const correction = reader.find ? findCorrection(utterance, span, reader.find) : null;
  if (correction && !correction.spansMarker) {
    // The quote stops at a value the rep took back. The model either kept it (or some other
    // value): `value_mismatch`; or wrote the new value against the old words, which only the
    // `self_correction` flag points out. Nothing is replaced: the quote reads as the old value.
    const right = among(reader, value, reader.read(slice(correction.replacement)));
    return right
      ? { value, flags: ["self_correction"], verdict: "supported" }
      : { value, flags: ["self_correction", "value_mismatch"], verdict: "mismatch" };
  }
  const quote = correction ? slice(correction.replacement) : slice(span);
  const reading = reader.read(quote);
  const flags: FieldFlagKind[] = [];
  if (correction && !among(reader, value, reading)) {
    // The quote runs on into the new value, and the model kept an old one.
    if (correction.taken.some((range) => among(reader, value, reader.read(slice(range))))) {
      flags.push("self_correction");
    }
  }
  if (reading === null) return { value, flags: [...flags, "unsupported"], verdict: "unread" };
  const norm: FieldNorm = {};
  if (reading.currency) norm.currency = reading.currency;
  // The currency rides along on every outcome that doesn't set its own `norm`.
  const withNorm = (outcome: Outcome): Outcome =>
    outcome.norm || Object.keys(norm).length === 0 ? outcome : { ...outcome, norm };
  if (fieldCurrency !== null && reading.currency && reading.currency !== fieldCurrency) {
    // "forty thousand euros" in a field kept in dollars: never converted, and never replaced,
    // since the words' number is in another currency. The model's value stands, flagged.
    return withNorm({ value, flags: [...flags, "value_mismatch"], verdict: "mismatch" });
  }
  if (!reading.certain) {
    return withNorm({ value, flags: [...flags, "ambiguous_value"], verdict: "ambiguous" });
  }
  const right = among(reader, value, reading);
  const [only, ...rest] = reading.readings;
  if (only !== undefined && rest.length === 0) {
    if (right) {
      return withNorm({ value: only, flags, verdict: flags.length > 0 ? "mismatch" : "supported" });
    }
    // Decision 12: a unique, certain reading replaces the model's value.
    return withNorm({
      value: only,
      norm: { ...norm, llmValue: value },
      flags: [...flags, "value_mismatch"],
      verdict: "replaced",
    });
  }
  return withNorm({
    value,
    norm: { ...norm, readings: [...reading.readings] },
    flags: right ? [...flags, "ambiguous_value"] : [...flags, "value_mismatch", "ambiguous_value"],
    verdict: right ? "ambiguous" : "mismatch",
  });
}

// ─── Names, emails, phones, verbatim text ────────────────────────────────────────────────────

const TRAILING = new Set([".", ",", ";", ":", "!", "?"]);

function trimTrailing(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING.has(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * An email address as it compares: lowercased, with spoken forms written out ("dana dot lee at
 * acme dot com" is "dana.lee@acme.com") and no spaces or closing punctuation.
 */
export function normalizeEmail(text: string): string {
  // Whitespace runs collapse first, in one linear pass, and the spoken forms then match single
  // spaces. `/\s+at\s+/` retried from every position of a long whitespace run: quadratic time
  // (CodeQL's js/polynomial-redos).
  const spoken = ` ${text.normalize("NFKC").toLowerCase().trim()} `
    .replace(/\s+/gu, " ")
    .replace(/^ mailto:/u, " ")
    .replaceAll(" at ", "@")
    .replaceAll(" dot ", ".")
    .replaceAll(" underscore ", "_")
    .replace(/ (?:dash|hyphen) /gu, "-")
    .replaceAll(" ", "");
  return trimTrailing(spoken);
}

const PHONE_DIGITS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * A phone number's digits, spoken or written: "(555) 010-4477" and "five five five, oh one oh,
 * four four seven seven" are both "5550104477". "double five" is "55", "triple oh" is "000".
 */
export function normalizePhone(text: string): string {
  let digits = "";
  let repeat = 1;
  for (const token of text.toLowerCase().match(/\d+|[a-z]+/gu) ?? []) {
    if (/^\d+$/u.test(token)) {
      digits += token;
      repeat = 1;
    } else if (token === "double" || token === "triple") {
      repeat = token === "double" ? 2 : 3;
    } else {
      const digit = PHONE_DIGITS[token];
      if (digit !== undefined) digits += digit.repeat(repeat);
      repeat = 1;
    }
  }
  return digits;
}

function samePhone(left: string, right: string): boolean {
  if (left === "" || right === "") return false;
  if (left === right) return true;
  // A country code one side said and the other didn't: "+1 555 010 4477".
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return long.length === short.length + 1 && long.startsWith("1") && long.endsWith(short);
}

function checkEqual(
  value: FieldValue,
  quote: string,
  same: (value: string, quote: string) => boolean,
): Outcome {
  const right = typeof value === "string" && same(value, quote);
  return right
    ? { value, flags: [], verdict: "supported" }
    : { value, flags: ["value_mismatch"], verdict: "mismatch" };
}

function sameName(value: string, quote: string): boolean {
  const normalized = normalizeName(value);
  return normalized !== "" && normalized === normalizeName(quote);
}

function sameEmail(value: string, quote: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized !== "" && normalized === normalizeEmail(quote);
}

function verbatim(value: string, quote: string): boolean {
  const folded = foldName(value);
  return folded !== "" && ` ${foldName(quote)} `.includes(` ${folded} `);
}

// ─── Free text ───────────────────────────────────────────────────────────────────────────────

/** Function words, which say nothing about whether a value came from the turn. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then so as at by for from in into of on onto to with about over " +
    "under up down out off via per than that this these those there here it its they them " +
    "their theirs we us our ours i me my mine you your yours he him his she her hers is are " +
    "was were be been being am do does did done have has had having will would shall should " +
    "can could may might must just also very really now too which who whom whose what when " +
    "where why how all any some each every both either um uh okay ok yeah yes well let get " +
    "got gonna wanna it's they're they've they'll we're we've we'll i'm i've i'll i'd you're " +
    "you've you'll he's she's that's there's here's what's let's"
  ).split(" "),
);

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
};

/** A light suffix stripper, the same on both sides: "quoting", "quoted", "quotes" are "quot". */
function stem(word: string): string {
  let out = word.endsWith("'s") ? word.slice(0, -2) : word;
  if (out.length > 4 && out.endsWith("ies")) return `${out.slice(0, -3)}y`;
  let stripped = false;
  if (out.length > 5 && out.endsWith("ing")) {
    out = out.slice(0, -3);
    stripped = true;
  } else if (out.length > 4 && out.endsWith("ed")) {
    out = out.slice(0, -2);
    stripped = true;
  } else if (out.length > 4 && /(?:s|x|z|ch|sh)es$/u.test(out)) {
    out = out.slice(0, -2);
  } else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) {
    out = out.slice(0, -1);
  }
  // "running" → "runn" → "run"; "stalling" keeps its "ll".
  if (stripped && /([^aeiouls])\1$/u.test(out)) out = out.slice(0, -1);
  if (out.length > 3 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

/**
 * The content words of a text, stemmed: function words dropped, number words as digits ("sixty"
 * is "60"), and every "n't" as "not".
 */
export function contentWords(text: string): string[] {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’ʼ]/gu, "'")
      .match(/\p{N}{1,3}(?:,\p{N}{3})+|[\p{L}\p{N}]+(?:'\p{L}+)?/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.endsWith("n't") || raw === "cannot" ? "not" : raw.replaceAll(",", "");
    if (STOPWORDS.has(word)) continue;
    out.push(NUMBER_WORDS[word] ?? stem(word));
  }
  return out;
}

/**
 * The share of a value's distinct content words that the turn also has, from 0 to 1. A value with
 * no content words shares nothing: 0.
 */
export function contentWordOverlap(value: string, turn: string): number {
  const valueWords = new Set(contentWords(value));
  if (valueWords.size === 0) return 0;
  const turnWords = new Set(contentWords(turn));
  let shared = 0;
  for (const word of valueWords) if (turnWords.has(word)) shared += 1;
  return shared / valueWords.size;
}

function checkText(value: FieldValue, turnText: string): Outcome {
  const overlap = contentWordOverlap(typeof value === "string" ? value : String(value), turnText);
  return overlap >= WEAK_SUPPORT_THRESHOLD
    ? { value, flags: [], verdict: "supported", overlap }
    : { value, flags: ["weak_support"], verdict: "weak", overlap };
}

// ─── The check ───────────────────────────────────────────────────────────────────────────────

function outcomeFor(input: FieldInput, context: CheckContext): Outcome {
  const quote = input.utterance.slice(input.span[0], input.span[1]);
  switch (input.kind) {
    case "date":
      return checkReadings(input, dateReader(context), null);
    case "amount":
      return checkReadings(input, AMOUNT_READER, context.currency ?? "USD");
    case "time": {
      const outcome = checkReadings(input, TIME_READER, null);
      // A meeting time on a day the clocks change: chrono's offset is the call's, so look twice.
      if (context.date && offsetChangesOn(context.date, context.timeZone)) {
        return { ...outcome, flags: [...outcome.flags, "ambiguous_value"] };
      }
      return outcome;
    }
    case "name":
      return checkEqual(input.value, quote, sameName);
    case "email":
      return checkEqual(input.value, quote, sameEmail);
    case "phone":
      return checkEqual(input.value, quote, (value, said) =>
        samePhone(normalizePhone(value), normalizePhone(said)),
      );
    case "verbatim":
      return checkEqual(input.value, quote, verbatim);
    case "text":
      return checkText(input.value, context.turnText);
  }
}

/**
 * Checks one field's value against its quote (spec WP7 step 5), after the normalizers: the value
 * to store, `norm` when there's something to record, and the flags, in a fixed order. A null
 * value is unchecked.
 */
export function checkField(input: FieldInput, context: CheckContext): FieldCheck {
  if (input.value === null) return { value: null, flags: [], verdict: "unchecked" };
  const outcome = outcomeFor(input, context);
  const kinds = new Set(outcome.flags);
  if (isNegated(input.utterance, input.span)) kinds.add("negation");
  return {
    value: outcome.value,
    ...(outcome.norm ? { norm: outcome.norm } : {}),
    flags: FLAG_ORDER.filter((kind) => kinds.has(kind)).map((kind) => ({
      kind,
      field: input.field,
    })),
    verdict: outcome.verdict,
    ...(outcome.overlap === undefined ? {} : { overlap: outcome.overlap }),
  };
}
