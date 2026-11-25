// Corrections (Phase 5 spec WP13 step 2, decision 11; ADR-0038): the rep says or types the right
// value for one part of a proposal, and code reads it into a proposal that supersedes the original.
// No model call and no key, so it's instant, free, and the same every time.
//
// - The record goes through the entity linker (`link`), with the session's index, its open account,
//   and its earlier links, as the understanding step's does.
// - Dates, times, and amounts go through the normalizers. An ambiguous reading keeps its readings
//   and `ambiguous_value`; words with no reading of the field's kind are refused, and the caller
//   says so ("I couldn't read a date in “…”") and writes nothing.
// - Every other field takes the words as said, less a lead-in like "no, it's" or "make it".
// - The fields not corrected keep their values, evidence, and flags. The corrected field's evidence
//   points at the correction's own words.
//
// Pure, like the rest of the package: SessionDO and the web Worker both run it. The shapes it
// shares with `@earshot/core` are restated here, as the linker's are, and a type test in
// @earshot/evals holds the two to each other.
import { FIELD_KINDS, type FieldNorm, type FieldValue, fieldKind } from "../faithfulness";
import {
  type EntityKind,
  isLinkUncertain,
  LINKER_PARAMS_V1,
  type LinkerParams,
  type LinkIndex,
  link,
  type TargetBasis,
  type TargetCandidate,
  type TargetDecision,
} from "../link";
import {
  type CurrencyCode,
  findAmounts,
  findDates,
  isNegated,
  offsetChangesOn,
  resolveTime,
} from "../normalize";
import type { TierFlag } from "../tiers";

/** `@earshot/core`'s `TARGET_FIELD`: what a correction of the record names. */
export const CORRECTION_TARGET = "target";

/**
 * Evidence below this confidence gets `low_confidence`: `@earshot/agent`'s
 * `LOW_CONFIDENCE_THRESHOLD`, restated (a test in @earshot/agent holds them equal).
 */
export const CORRECTION_LOW_CONFIDENCE = 0.7;

/** The currency an amount field is kept in: the tool schema's, US dollars. */
const FIELD_CURRENCY: CurrencyCode = "USD";

/** `@earshot/core`'s `Evidence`. */
export interface CorrectionEvidence {
  readonly utteranceId: string;
  readonly span: [number, number];
  readonly audioMs: [number, number];
  readonly confidence: number;
}

/** `@earshot/core`'s `ProposalFieldV2`. */
export interface CorrectionFieldValue {
  readonly value: FieldValue;
  readonly evidence: CorrectionEvidence;
  readonly norm?: FieldNorm | undefined;
}

/** `@earshot/core`'s `TargetV2`. */
export interface CorrectionTargetValue {
  readonly decision: TargetDecision;
  readonly entityId: string | null;
  readonly kind: EntityKind | null;
  readonly basis: TargetBasis | null;
  readonly p: number | null;
  readonly mention: { readonly quote: string; readonly evidence: CorrectionEvidence } | null;
  readonly company: {
    readonly quote: string;
    readonly evidence: CorrectionEvidence;
    readonly entityId: string | null;
  } | null;
  readonly candidates: TargetCandidate[];
}

/** `@earshot/core`'s `ProposalTypeV2`. */
export type CorrectionProposalType =
  | "note"
  | "task"
  | "contact"
  | "deal_update"
  | "commitment"
  | "meeting";

/**
 * The proposal being corrected, as the session's projection folded it (`ProposalView` fits): its
 * flags include any a witness added after it was made.
 */
export interface CorrectableProposal {
  readonly proposalId: string;
  readonly type: CorrectionProposalType;
  readonly target: CorrectionTargetValue;
  readonly fields: Readonly<Record<string, CorrectionFieldValue>>;
  readonly riskFlags: readonly TierFlag[];
  /**
   * The linker that resolved its record, from its `proposal.created` (the projection doesn't keep
   * it). A field's correction leaves the record, so its linker carries over; null when unknown.
   */
  readonly linker?: string | null | undefined;
}

/** One utterance of the correction turn: `utterance.final` v3, said or typed. */
export interface CorrectionUtterance {
  readonly utteranceId: string;
  readonly text: string;
  readonly confidence: number;
  readonly words?:
    | readonly {
        readonly w: string;
        readonly startMs: number;
        readonly endMs: number;
        readonly confidence: number;
      }[]
    | undefined;
  readonly startMs: number;
  readonly endMs: number;
}

/** The session, as the linker and the date normalizers see it. */
export interface CorrectionContext {
  /** The session's records, indexed: `start`'s in SessionDO, the mirror's in the web Worker. */
  readonly index: LinkIndex;
  /** The account open when the session started, or null. */
  readonly focusEntityId: string | null;
  /** Records the session linked before, most recent first. */
  readonly recent: readonly string[];
  /** The record kinds the proposal's type can target (`@earshot/agent`'s `TARGET_KINDS`). */
  readonly kinds: readonly EntityKind[];
  /** When the call happened (ISO 8601) and the rep's IANA time zone, for dates. */
  readonly callTime: string;
  readonly timeZone: string;
  /** The linker's frozen parameters: `LINKER_PARAMS_V1` when absent. */
  readonly params?: LinkerParams;
}

/**
 * `proposal.created` v2's payload without its `proposalId`, which the writer derives from the
 * correction's id: a proposal that supersedes the one corrected.
 */
export interface CorrectedProposal {
  readonly type: CorrectionProposalType;
  readonly target: CorrectionTargetValue;
  readonly fields: Record<string, CorrectionFieldValue>;
  readonly riskFlags: TierFlag[];
  readonly supersedes: string;
  readonly linker: string | null;
}

/** What a refused correction couldn't read, for the caller's sentence. */
export type UnreadableKind = "date" | "time" | "amount" | "record";

export type CorrectionResult =
  | {
      readonly ok: true;
      readonly proposal: CorrectedProposal;
      /** The value read: the field's new value, or the record's id (null for a new record). */
      readonly value: FieldValue;
      /** The words read, as said. */
      readonly words: string;
    }
  | {
      readonly ok: false;
      /**
       * - `unknown_field`: neither the record nor one of the type's fields;
       * - `no_words`: nothing left once a lead-in like "no, it's" is set aside;
       * - `unreadable`: no date, time, or amount in the words, or no record they could name.
       */
      readonly reason: "unknown_field" | "no_words" | "unreadable";
      /** For `unreadable`, what wasn't there. */
      readonly kind: UnreadableKind | null;
      /** The words that were read, trimmed, for "I couldn't read a date in “…”". */
      readonly words: string;
    };

// ─── Words ───────────────────────────────────────────────────────────────────────────────────

/** One whitespace-separated word of an utterance, its edge punctuation set aside. */
interface TextWord {
  /** `[start, end)` without edge punctuation. */
  readonly start: number;
  readonly end: number;
  /** Lowercased, curly apostrophes straightened. */
  readonly key: string;
}

function isSpace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The utterance's words, each with its span: a scan, so no input can make it slow. */
function textWords(text: string): TextWord[] {
  const words: TextWord[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isSpace(text.charCodeAt(index))) index += 1;
    const runStart = index;
    while (index < text.length && !isSpace(text.charCodeAt(index))) index += 1;
    let first = runStart;
    let last = index;
    while (first < last && !WORD_CHAR.test(text.charAt(first))) first += 1;
    while (last > first && !WORD_CHAR.test(text.charAt(last - 1))) last -= 1;
    if (first < last) {
      words.push({
        start: first,
        end: last,
        key: text.slice(first, last).toLowerCase().replaceAll("’", "'").replaceAll("‘", "'"),
      });
    }
  }
  return words;
}

/**
 * What a rep says before the value ("no, it's", "actually, I meant", "make it", "change it to"),
 * which a correction sets aside: each a run of words, read from the start, again and again until
 * none matches. Fillers count only first.
 */
const LEAD_INS: readonly (readonly string[])[] = [
  ["no"],
  ["nope"],
  ["nah"],
  ["actually"],
  ["sorry"],
  ["oh"],
  ["um"],
  ["uh"],
  ["er"],
  ["wait"],
  ["okay"],
  ["ok"],
  ["so"],
  ["well"],
  ["oops"],
  ["i", "meant"],
  ["i", "mean"],
  ["i", "said"],
  ["it", "should", "say"],
  ["it", "should", "be"],
  ["it", "should", "read"],
  ["should", "be"],
  ["it's"],
  ["its"],
  ["it", "is"],
  ["it", "was"],
  ["that's"],
  ["that", "is"],
  ["make", "it"],
  ["make", "that"],
  ["change", "it", "to"],
  ["change", "that", "to"],
  ["set", "it", "to"],
  ["the", "right", "one", "is"],
];

/** The words left once lead-ins are set aside: their span in the text, or null when none are. */
function valueSpan(text: string): readonly [number, number] | null {
  const words = textWords(text);
  let at = 0;
  for (let matched = true; matched && at < words.length; ) {
    matched = false;
    for (const lead of LEAD_INS) {
      if (lead.every((word, offset) => words[at + offset]?.key === word)) {
        at += lead.length;
        matched = true;
        break;
      }
    }
  }
  const first = words[at];
  const last = words.at(-1);
  if (!first || !last || at >= words.length) return null;
  return [first.start, last.end];
}

/** Text with its ends' whitespace scanned off. */
function trimmed(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Every utterance's words joined, for the refusal's quote. */
function allWords(utterances: readonly CorrectionUtterance[]): string {
  return trimmed(utterances.map((utterance) => trimmed(utterance.text)).join(" "));
}

// ─── Evidence ────────────────────────────────────────────────────────────────────────────────

/** How far ahead a recognized word is looked for among the text's words (as `@earshot/agent`). */
const ALIGN_LOOKAHEAD = 3;

/**
 * The evidence for a span of an utterance, by `@earshot/agent`'s `evidenceFor` rules: with word
 * timings that line up with every word the span touches, those words' audio window and the lowest
 * of their confidences; otherwise the window interpolated by character position across the
 * utterance, with the utterance's confidence. A typed utterance's window is empty, at its time.
 */
function evidenceAt(
  utterance: CorrectionUtterance,
  span: readonly [number, number],
): CorrectionEvidence {
  const [start, end] = span;
  const words = textWords(utterance.text);
  const covered = words.flatMap((word, index) =>
    word.start < end && word.end > start ? [index] : [],
  );
  const recognized = utterance.words ?? [];
  if (recognized.length > 0 && covered.length > 0) {
    const byTextWord = new Map<number, (typeof recognized)[number]>();
    let next = 0;
    for (const word of recognized) {
      const key = textWords(word.w)[0]?.key;
      for (
        let k = next;
        key !== undefined && k < words.length && k <= next + ALIGN_LOOKAHEAD;
        k++
      ) {
        if (words[k]?.key === key) {
          byTextWord.set(k, word);
          next = k + 1;
          break;
        }
      }
    }
    const matched = covered.map((index) => byTextWord.get(index));
    if (matched.every((word) => word !== undefined)) {
      return {
        utteranceId: utterance.utteranceId,
        span: [start, end],
        audioMs: [
          Math.min(...matched.map((word) => word.startMs)),
          Math.max(...matched.map((word) => word.endMs)),
        ],
        confidence: Math.min(...matched.map((word) => word.confidence)),
      };
    }
  }
  const length = Math.max(utterance.text.length, 1);
  const durationMs = Math.max(utterance.endMs - utterance.startMs, 0);
  const at = (offset: number) => utterance.startMs + Math.round((durationMs * offset) / length);
  return {
    utteranceId: utterance.utteranceId,
    span: [start, end],
    audioMs: [at(start), at(end)],
    confidence: utterance.confidence,
  };
}

// ─── Reading values ──────────────────────────────────────────────────────────────────────────

/** A value read from the correction's words, where it was said, and what to flag. */
interface Reading {
  readonly value: FieldValue;
  readonly utterance: CorrectionUtterance;
  readonly span: readonly [number, number];
  readonly norm?: FieldNorm;
  readonly flags: readonly ("ambiguous_value" | "value_mismatch")[];
}

/**
 * The last expression found across the utterances that isn't negated ("not Friday, Monday" means
 * Monday): what a rep says last is what they mean.
 */
function lastUnnegated<T extends { readonly start: number; readonly end: number }>(
  utterances: readonly CorrectionUtterance[],
  find: (text: string) => readonly T[],
): { readonly utterance: CorrectionUtterance; readonly found: T } | null {
  let best: { utterance: CorrectionUtterance; found: T } | null = null;
  for (const utterance of utterances) {
    for (const found of find(utterance.text)) {
      if (isNegated(utterance.text, [found.start, found.end])) continue;
      best = { utterance, found };
    }
  }
  return best;
}

function readDate(
  utterances: readonly CorrectionUtterance[],
  ctx: CorrectionContext,
): Reading | null {
  const hit = lastUnnegated(utterances, (text) => findDates(text, ctx.callTime, ctx.timeZone));
  if (!hit) return null;
  const { readings, certain, start, end } = hit.found;
  const [first] = readings;
  if (first === undefined) return null;
  const several = readings.length > 1;
  return {
    value: first,
    utterance: hit.utterance,
    span: [start, end],
    ...(several ? { norm: { readings: [...readings] } } : {}),
    flags: several || !certain ? ["ambiguous_value"] : [],
  };
}

function readTime(
  utterances: readonly CorrectionUtterance[],
  ctx: CorrectionContext,
  date: FieldValue | undefined,
): Reading | null {
  for (const utterance of [...utterances].reverse()) {
    const span = valueSpan(utterance.text);
    if (span === null) continue;
    const time = resolveTime(utterance.text.slice(span[0], span[1]));
    const [first] = time?.readings ?? [];
    if (!time || first === undefined) continue;
    const several = time.readings.length > 1;
    // A time on a day the clocks change reads two ways, as the faithfulness check says.
    const shifts = typeof date === "string" && offsetChangesOn(date, ctx.timeZone);
    return {
      value: first,
      utterance,
      span,
      ...(several ? { norm: { readings: [...time.readings] } } : {}),
      flags: several || !time.certain || shifts ? ["ambiguous_value"] : [],
    };
  }
  return null;
}

function readAmount(utterances: readonly CorrectionUtterance[]): Reading | null {
  const hit = lastUnnegated(utterances, findAmounts);
  if (!hit) return null;
  const { readings, currency, start, end } = hit.found;
  const [first] = readings;
  if (first === undefined) return null;
  const several = readings.length > 1;
  const norm: FieldNorm = {
    ...(several ? { readings: [...readings] } : {}),
    ...(currency ? { currency } : {}),
  };
  const flags: ("ambiguous_value" | "value_mismatch")[] = [];
  // Never converted: an amount in another currency stands as said, flagged, as the check does.
  if (currency !== null && currency !== FIELD_CURRENCY) flags.push("value_mismatch");
  if (several) flags.push("ambiguous_value");
  return {
    value: first,
    utterance: hit.utterance,
    span: [start, end],
    ...(Object.keys(norm).length > 0 ? { norm } : {}),
    flags,
  };
}

/** The words as said, from the last utterance that has any once its lead-in is set aside. */
function readWords(utterances: readonly CorrectionUtterance[]): Reading | null {
  for (const utterance of [...utterances].reverse()) {
    const span = valueSpan(utterance.text);
    if (span === null) continue;
    return { value: utterance.text.slice(span[0], span[1]), utterance, span, flags: [] };
  }
  return null;
}

/** An email as said, its spoken forms written out ("dana dot lee at acme dot com"). */
function writtenEmail(said: string): string {
  const spoken = ` ${said.normalize("NFKC").toLowerCase()} `
    .replace(/\s+/gu, " ")
    .replaceAll(" at ", "@")
    .replaceAll(" dot ", ".")
    .replaceAll(" underscore ", "_")
    .replaceAll(" dash ", "-")
    .replaceAll(" hyphen ", "-")
    .replaceAll(" ", "");
  return spoken.includes("@") ? spoken : trimmed(said);
}

// ─── The correction ──────────────────────────────────────────────────────────────────────────

const flag = (kind: TierFlag["kind"], field: string): TierFlag => ({ kind, field });

/** The flags a correction of `fields` leaves: every other field's, and the proposal's own. */
function keptFlags(flags: readonly TierFlag[], fields: readonly string[]): TierFlag[] {
  return flags.filter((item) => item.field === undefined || !fields.includes(item.field));
}

/** A field's flags from its new evidence: low confidence, and words in a negation. */
function evidenceFlags(reading: Reading, evidence: CorrectionEvidence, field: string): TierFlag[] {
  const flags: TierFlag[] = reading.flags.map((kind) => flag(kind, field));
  if (evidence.confidence < CORRECTION_LOW_CONFIDENCE) flags.push(flag("low_confidence", field));
  if (isNegated(reading.utterance.text, reading.span)) flags.push(flag("negation", field));
  return flags;
}

function unreadable(
  kind: UnreadableKind,
  utterances: readonly CorrectionUtterance[],
): CorrectionResult {
  return { ok: false, reason: "unreadable", kind, words: allWords(utterances) };
}

/**
 * Links a corrected record's words, kind by kind: first the kind the original's record was said to
 * be, then each other kind the type allows, taking the first that links (a task first said to be
 * about a person can be corrected to a company). When none links, the first try's answer stands: a
 * question, a new company or contact, or nothing. The linker's model weighs the kind, so a name
 * read with the right kind links where one read with none would only ask.
 */
function linkRecord(
  quote: string,
  original: CorrectableProposal,
  ctx: CorrectionContext,
  params: LinkerParams,
): { readonly result: ReturnType<typeof link>; readonly kind: EntityKind | null } {
  // A contact is linked with its company field as context, as the understanding step links it.
  const company = original.type === "contact" ? original.fields.company?.value : undefined;
  const companyText = typeof company === "string" ? company : null;
  const context = {
    index: ctx.index,
    focusEntityId:
      ctx.focusEntityId !== null && ctx.index.byId.has(ctx.focusEntityId)
        ? ctx.focusEntityId
        : null,
    recent: ctx.recent,
    turnMentions: [],
    kinds: ctx.kinds,
    params,
  };
  const said = original.target.kind;
  const kinds: (EntityKind | null)[] =
    said !== null && ctx.kinds.includes(said)
      ? [said, ...ctx.kinds.filter((kind) => kind !== said)]
      : ctx.kinds.length > 0
        ? [...ctx.kinds]
        : [null];
  let first: { result: ReturnType<typeof link>; kind: EntityKind | null } | null = null;
  for (const kind of kinds) {
    const result = link({ text: quote, kind, companyText }, context);
    if (result.decision === "linked") return { result, kind };
    first ??= { result, kind };
  }
  return first ?? { result: link({ text: quote, kind: null, companyText }, context), kind: null };
}

/**
 * Reads a correction of `field` (`target`, or one of the proposal type's fields) from the correction
 * turn's utterances into a proposal that supersedes `original`, or says why it can't. No model call
 * and no key: the linker for the record, the normalizers for dates, times, and amounts, the words as
 * said for everything else. A contact's record is linked on its name, so correcting either corrects
 * both.
 */
export function correctProposal(
  original: CorrectableProposal,
  field: string,
  utterances: readonly CorrectionUtterance[],
  ctx: CorrectionContext,
): CorrectionResult {
  const names = Object.keys(FIELD_KINDS[original.type] ?? {});
  if (field !== CORRECTION_TARGET && !names.includes(field)) {
    return { ok: false, reason: "unknown_field", kind: null, words: allWords(utterances) };
  }
  const params = ctx.params ?? LINKER_PARAMS_V1;
  const record = field === CORRECTION_TARGET || (original.type === "contact" && field === "name");
  if (record) return correctRecord(original, utterances, ctx, params);

  const kind = fieldKind(original.type, field);
  let reading: Reading | null;
  switch (kind) {
    case "date":
      reading = readDate(utterances, ctx);
      if (reading === null) return unreadable("date", utterances);
      break;
    case "time":
      reading = readTime(utterances, ctx, original.fields.date?.value);
      if (reading === null) return unreadable("time", utterances);
      break;
    case "amount":
      reading = readAmount(utterances);
      if (reading === null) return unreadable("amount", utterances);
      break;
    default: {
      const words = readWords(utterances);
      if (words === null)
        return { ok: false, reason: "no_words", kind: null, words: allWords(utterances) };
      reading = kind === "email" ? { ...words, value: writtenEmail(String(words.value)) } : words;
    }
  }
  const evidence = evidenceAt(reading.utterance, reading.span);
  const corrected: CorrectionFieldValue = {
    value: reading.value,
    evidence,
    ...(reading.norm ? { norm: reading.norm } : {}),
  };
  return {
    ok: true,
    proposal: {
      type: original.type,
      target: original.target,
      fields: { ...original.fields, [field]: corrected },
      riskFlags: [
        ...keptFlags(original.riskFlags, [field]),
        ...evidenceFlags(reading, evidence, field),
      ],
      supersedes: original.proposalId,
      linker: original.linker ?? null,
    },
    value: reading.value,
    words: reading.utterance.text.slice(reading.span[0], reading.span[1]),
  };
}

/** A correction of the record: the words as said go to the linker, as a target's quote does. */
function correctRecord(
  original: CorrectableProposal,
  utterances: readonly CorrectionUtterance[],
  ctx: CorrectionContext,
  params: LinkerParams,
): CorrectionResult {
  const words = readWords(utterances);
  if (words === null)
    return { ok: false, reason: "no_words", kind: null, words: allWords(utterances) };
  const quote = String(words.value);
  const { result, kind } = linkRecord(quote, original, ctx, params);
  if (result.decision === "none") return unreadable("record", utterances);
  const evidence = evidenceAt(words.utterance, words.span);
  const target: CorrectionTargetValue = {
    decision: result.decision,
    entityId: result.entityId,
    kind,
    basis: result.basis,
    p: result.p,
    mention: { quote, evidence },
    company: null,
    candidates: result.candidates.map((candidate) => ({
      entityId: candidate.entityId,
      p: candidate.p,
    })),
  };
  const flags: TierFlag[] = [];
  if (result.decision === "ask") flags.push(flag("ambiguous_target", CORRECTION_TARGET));
  if (result.decision === "new") flags.push(flag("new_entity", CORRECTION_TARGET));
  if (isLinkUncertain(result)) flags.push(flag("link_uncertain", CORRECTION_TARGET));
  const contact = original.type === "contact";
  const replaced = contact ? [CORRECTION_TARGET, "name"] : [CORRECTION_TARGET];
  const fields = contact
    ? { ...original.fields, name: { value: quote, evidence } }
    : { ...original.fields };
  if (contact && evidence.confidence < CORRECTION_LOW_CONFIDENCE) {
    flags.push(flag("low_confidence", "name"));
  }
  return {
    ok: true,
    proposal: {
      type: original.type,
      target,
      fields,
      riskFlags: [...keptFlags(original.riskFlags, replaced), ...flags],
      supersedes: original.proposalId,
      linker: params.version,
    },
    value: result.entityId,
    words: quote,
  };
}
