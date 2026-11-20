// Amounts (spec WP7 step 2; decision 10): a hand-written parser for the way reps say money. The
// libraries were stale (`words-to-numbers` 1.5.1, 2018) or heavy (`compromise`, 2.9 MB unpacked),
// and the domain is narrow:
// - digits, with commas and decimals: "$45,000", "1.2 million";
// - words: "forty-two thousand", "a hundred and twenty thousand", "one point five million",
//   "forty-five hundred", "half a million";
// - shorthand: "45k", "fifty k", "40 grand", "2 mil", "$1.2M";
// - ranges and alternatives, which have two readings: "50 to 60k", "between fifty and sixty
//   thousand", "fifty or sixty grand";
// - currencies: "$", USD, dollars, and bucks are USD; "€", EUR, and euros are EUR; "£", GBP,
//   pounds, and quid are GBP.
// The evals keep their own parser (`parseUsd` in @earshot/evals, decision 13); a conformance test
// there holds the two to the same answers on every ground-truth amount.

/** The currencies a rep names, as ISO 4217 codes. */
export type CurrencyCode = "USD" | "EUR" | "GBP";

/** What an amount's words say. */
export interface AmountReading {
  /** The amount; for a range or alternatives, the first reading. */
  readonly value: number;
  /** Every amount the words name: one, or two for "50 to 60k" or "fifty or sixty thousand". */
  readonly readings: readonly number[];
  /** The currency the words name, or null when they name none. */
  readonly currency: CurrencyCode | null;
  /** Whether there is more than one reading. */
  readonly ambiguous: boolean;
}

/** An amount found in a text, and where. */
export interface AmountExpression extends AmountReading {
  /** `[start, end)` in the text. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /**
   * A lone number word or numeral under 100 with no currency and no scale ("one", "three"):
   * an amount only by context, so the correction check doesn't take it for one.
   */
  readonly bare: boolean;
}

type Lexeme =
  | { readonly kind: "number"; readonly value: number; readonly scale: number | null }
  | { readonly kind: "word"; readonly key: string }
  | { readonly kind: "currency"; readonly code: CurrencyCode }
  | { readonly kind: "dash" }
  | { readonly kind: "punct"; readonly key: string };

type Positioned = Lexeme & { readonly start: number; readonly end: number };

const UNITS: Readonly<Record<string, number>> = {
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
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Words that multiply what comes before them: the scales, formal and spoken. */
const SCALE_WORDS: Readonly<Record<string, number>> = {
  thousand: 1e3,
  k: 1e3,
  grand: 1e3,
  million: 1e6,
  mil: 1e6,
  mill: 1e6,
  billion: 1e9,
  bn: 1e9,
};

/** Letters written onto a numeral: "45k", "1.2m", "$3mm", "2bn". */
const ATTACHED_SCALES: Readonly<Record<string, number>> = {
  k: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  mil: 1e6,
  b: 1e9,
  bn: 1e9,
};

/** Scales that may stand apart only after a numeral: "1.2 m". */
const NUMERAL_SCALE_WORDS: Readonly<Record<string, number>> = { m: 1e6, mm: 1e6 };

const SYMBOLS: Readonly<Record<string, CurrencyCode>> = { $: "USD", "€": "EUR", "£": "GBP" };
const CODES: Readonly<Record<string, CurrencyCode>> = { usd: "USD", eur: "EUR", gbp: "GBP" };
const CURRENCY_WORDS: Readonly<Record<string, CurrencyCode>> = {
  dollar: "USD",
  dollars: "USD",
  buck: "USD",
  bucks: "USD",
  usd: "USD",
  euro: "EUR",
  euros: "EUR",
  eur: "EUR",
  pound: "GBP",
  pounds: "GBP",
  quid: "GBP",
  sterling: "GBP",
  gbp: "GBP",
};

const DIGIT_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

/** Words that join two amounts into a range or alternatives ("and" only after "between"). */
const CONNECTORS: ReadonlySet<string> = new Set(["to", "through", "thru", "till", "until", "or"]);

const LEXEME =
  /([$€£])|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(\p{L}+)?|(\p{L}+(?:['’]\p{L}+)*)|([-–—])|(\S)/gu;

function lex(text: string): Positioned[] {
  const out: Positioned[] = [];
  for (const match of text.matchAll(LEXEME)) {
    const start = match.index;
    const end = start + match[0].length;
    const [, symbol, numeral, letters, word, dash, other] = match;
    if (symbol !== undefined) {
      out.push({ kind: "currency", code: SYMBOLS[symbol] ?? "USD", start, end });
    } else if (numeral !== undefined) {
      const value = Number(numeral.replaceAll(",", ""));
      if (letters === undefined) {
        out.push({ kind: "number", value, scale: null, start, end });
      } else {
        const scale = ATTACHED_SCALES[letters.toLowerCase()];
        // "4th", "3pm", "10x": not amounts.
        if (scale === undefined)
          out.push({ kind: "word", key: match[0].toLowerCase(), start, end });
        else out.push({ kind: "number", value, scale, start, end });
      }
    } else if (word !== undefined) {
      out.push({ kind: "word", key: word.toLowerCase().replace(/’/gu, "'"), start, end });
    } else if (dash !== undefined) {
      out.push({ kind: "dash", start, end });
    } else {
      out.push({ kind: "punct", key: other ?? "", start, end });
    }
  }
  // A hyphen inside a compound number word ("forty-two") only joins: drop it.
  return out.filter((lexeme, index) => {
    if (lexeme.kind !== "dash") return true;
    const before = out[index - 1];
    const after = out[index + 1];
    return !(
      before?.kind === "word" &&
      after?.kind === "word" &&
      before.end === lexeme.start &&
      lexeme.end === after.start
    );
  });
}

interface Parsed {
  readonly value: number;
  /** The largest scale used ("sixty thousand": 1,000), so a range's low end can borrow it. */
  readonly scale: number;
  readonly next: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

class Reader {
  private readonly lexemes: readonly Positioned[];

  constructor(lexemes: readonly Positioned[]) {
    this.lexemes = lexemes;
  }

  at(index: number): Positioned | undefined {
    return this.lexemes[index];
  }

  word(index: number): string | null {
    const lexeme = this.lexemes[index];
    return lexeme?.kind === "word" ? lexeme.key : null;
  }

  scale(index: number): number | null {
    const word = this.word(index);
    return word === null ? null : (SCALE_WORDS[word] ?? null);
  }

  /** 0 to 99 in words: "seven", "fifteen", "forty", "forty-two". */
  subHundred(index: number): { value: number; next: number } | null {
    const word = this.word(index);
    if (word === null) return null;
    const unit = UNITS[word];
    if (unit !== undefined) return { value: unit, next: index + 1 };
    const tens = TENS[word];
    if (tens === undefined) return null;
    const after = UNITS[this.word(index + 1) ?? ""];
    if (after !== undefined && after >= 1 && after <= 9) {
      return { value: tens + after, next: index + 2 };
    }
    return { value: tens, next: index + 1 };
  }

  /**
   * A group under the scales: "five", "twenty-five", "a hundred", "three hundred and six", and
   * the spoken "twelve hundred" or "forty-five hundred" (any 1 to 99 hundreds).
   */
  group(index: number): { value: number; next: number } | null {
    let lead = this.subHundred(index);
    const word = this.word(index);
    if (lead === null && (word === "a" || word === "an") && this.word(index + 1) === "hundred") {
      lead = { value: 1, next: index + 1 };
    }
    if (lead === null) return null;
    if (this.word(lead.next) !== "hundred" || lead.value === 0) return lead;
    const hundreds = lead.value * 100;
    const afterHundred = lead.next + 1;
    const tailAt = this.word(afterHundred) === "and" ? afterHundred + 1 : afterHundred;
    const tail = this.subHundred(tailAt);
    // "one hundred and two hundred" is two numbers, not 102 and a stray "hundred".
    if (tail !== null && tail.value > 0 && this.word(tail.next) !== "hundred") {
      return { value: hundreds + tail.value, next: tail.next };
    }
    return { value: hundreds, next: afterHundred };
  }

  /** "point five", after a group: the digits of a spoken decimal. */
  decimals(index: number): { fraction: number; next: number } | null {
    if (this.word(index) !== "point") return null;
    let digits = "";
    let at = index + 1;
    for (;;) {
      const digit = DIGIT_WORDS[this.word(at) ?? ""];
      if (digit === undefined) break;
      digits += String(digit);
      at += 1;
    }
    return digits === "" ? null : { fraction: Number(`0.${digits}`), next: at };
  }

  /** A number in words, scales in strictly falling order: "two million four hundred thousand". */
  wordNumber(index: number): Parsed | null {
    if (this.word(index) === "half") {
      const article = this.word(index + 1);
      const scale = this.scale(index + 2);
      if ((article === "a" || article === "an") && scale !== null) {
        return { value: 0.5 * scale, scale, next: index + 3 };
      }
    }
    let total = 0;
    let last = Number.POSITIVE_INFINITY;
    let top = 1;
    let at = index;
    let any = false;
    for (;;) {
      let group = this.group(at);
      const word = this.word(at);
      if (group === null && (word === "a" || word === "an") && this.scale(at + 1) !== null) {
        group = { value: 1, next: at + 1 };
      }
      if (group === null) break;
      let value = group.value;
      let next = group.next;
      const decimals = this.decimals(next);
      if (decimals !== null) {
        value += decimals.fraction;
        next = decimals.next;
      }
      // "one and a half million"
      if (
        this.word(next) === "and" &&
        this.word(next + 1) === "a" &&
        this.word(next + 2) === "half" &&
        this.scale(next + 3) !== null
      ) {
        value += 0.5;
        next += 3;
      }
      const scale = this.scale(next);
      if (scale === null) {
        // A group with no scale ends the number, unless it's too big to follow the last scale.
        if (value >= last) break;
        total += value;
        at = next;
        any = true;
        break;
      }
      // "five thousand six thousand" is two numbers.
      if (scale >= last) break;
      total += value * scale;
      last = scale;
      top = Math.max(top, scale);
      at = next + 1;
      any = true;
      // "a million and a half"
      if (this.word(at) === "and" && this.word(at + 1) === "a" && this.word(at + 2) === "half") {
        total += 0.5 * scale;
        at += 3;
        break;
      }
      // "one thousand and five": the "and" belongs to the number only if a smaller group follows.
      if (this.word(at) === "and") {
        const following = this.group(at + 1);
        const followingScale = following === null ? null : this.scale(following.next);
        if (following !== null && (followingScale === null || followingScale < last)) at += 1;
      }
    }
    return any ? { value: round(total), scale: top, next: at } : null;
  }

  /** A numeral, with a scale written onto it or after it: "45,000", "45k", "1.5 million". */
  numeral(index: number): Parsed | null {
    const lexeme = this.at(index);
    if (lexeme?.kind !== "number") return null;
    if (lexeme.scale !== null) {
      return { value: round(lexeme.value * lexeme.scale), scale: lexeme.scale, next: index + 1 };
    }
    const word = this.word(index + 1) ?? "";
    const scale = SCALE_WORDS[word] ?? NUMERAL_SCALE_WORDS[word];
    if (scale !== undefined) {
      return { value: round(lexeme.value * scale), scale, next: index + 2 };
    }
    if (word === "hundred" && Number.isInteger(lexeme.value) && lexeme.value < 100) {
      return { value: lexeme.value * 100, scale: 1, next: index + 2 };
    }
    return { value: lexeme.value, scale: 1, next: index + 1 };
  }

  /** A currency word after an amount: "dollars", "US dollars", "euros", "pounds sterling". */
  currencySuffix(index: number): { code: CurrencyCode; next: number } | null {
    let at = index;
    if (this.word(at) === "us" && CURRENCY_WORDS[this.word(at + 1) ?? ""] === "USD") at += 1;
    const code = CURRENCY_WORDS[this.word(at) ?? ""];
    if (code === undefined) return null;
    at += 1;
    if (code === "GBP" && this.word(at) === "sterling") at += 1;
    return { code, next: at };
  }

  /** One amount: an optional currency, a number, an optional currency word. */
  amount(index: number): (Parsed & { currency: CurrencyCode | null; bare: boolean }) | null {
    let at = index;
    let currency: CurrencyCode | null = null;
    const first = this.at(at);
    if (first?.kind === "currency") {
      currency = first.code;
      at += 1;
    } else {
      const code = CODES[this.word(at) ?? ""];
      if (code !== undefined && (this.at(at + 1)?.kind === "number" || this.group(at + 1))) {
        currency = code;
        at += 1;
      }
    }
    const number = this.numeral(at) ?? this.wordNumber(at);
    if (number === null) return null;
    let next = number.next;
    const after = this.at(next);
    // A percentage isn't an amount.
    if (after?.kind === "punct" && after.key === "%") return null;
    if (this.word(next) === "percent") return null;
    const suffix = this.currencySuffix(next);
    if (suffix !== null) {
      currency ??= suffix.code;
      next = suffix.next;
    }
    const bare = currency === null && number.scale === 1 && number.value < 100;
    return { ...number, next, currency, bare };
  }
}

/**
 * Every amount in a text, in order, each with its readings: one, or two for a range ("50 to
 * 60k") or alternatives ("fifty or sixty thousand"). A range's low end borrows the high end's
 * scale when it has none and reads no larger ("50 to 60k" is 50,000 to 60,000), and either end's
 * currency covers both.
 */
export function findAmounts(text: string): AmountExpression[] {
  const lexemes = lex(text);
  const reader = new Reader(lexemes);
  const found: AmountExpression[] = [];
  let index = 0;
  while (index < lexemes.length) {
    const low = reader.amount(index);
    if (low === null) {
      index += 1;
      continue;
    }
    let readings = [low.value];
    let currency = low.currency;
    let next = low.next;
    let bare = low.bare;
    const connector = reader.at(next);
    const word = reader.word(next);
    const between = reader.word(index - 1) === "between";
    const alternatives = word === "or";
    if (
      connector?.kind === "dash" ||
      (word !== null && CONNECTORS.has(word)) ||
      (word === "and" && between)
    ) {
      const high = reader.amount(next + 1);
      if (high !== null) {
        let lowValue = low.value;
        if (low.scale === 1 && high.scale > 1 && low.value <= high.value / high.scale) {
          lowValue = round(low.value * high.scale);
        }
        readings = lowValue === high.value ? [lowValue] : [lowValue, high.value];
        currency = low.currency ?? high.currency;
        next = high.next;
        bare = false;
      }
    }
    const first = lexemes[index];
    const last = lexemes[next - 1];
    if (first && last) {
      found.push({
        value: readings[0] ?? low.value,
        readings,
        currency,
        ambiguous: readings.length > 1,
        start: first.start,
        end: last.end,
        text: text.slice(first.start, last.end),
        bare: bare && !alternatives,
      });
    }
    index = next;
  }
  return found;
}

/**
 * What a quoted amount says: `{ value, currency, ambiguous }`, with every reading. A quote that
 * names several different amounts is ambiguous too, up to three readings; more is no reading.
 * Null when the quote names no amount.
 */
export function parseAmount(quote: string): AmountReading | null {
  const found = findAmounts(quote);
  const only = found[0];
  if (only === undefined) return null;
  if (found.length === 1) {
    const { value, readings, currency, ambiguous } = only;
    return { value, readings, currency, ambiguous };
  }
  const readings = [...new Set(found.flatMap((amount) => amount.readings))];
  if (readings.length > 3) return null;
  return {
    value: readings[0] ?? only.value,
    readings,
    currency: found.find((amount) => amount.currency !== null)?.currency ?? null,
    ambiguous: readings.length > 1,
  };
}
