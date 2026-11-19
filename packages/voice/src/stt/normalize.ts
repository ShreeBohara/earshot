// Normalization to `utterance.final` v2 (spec WP4 step 5): each word becomes `{ w, startMs,
// endMs, confidence }` on the session's audio clock, the utterance's confidence is the mean of
// its words', and `witness` is "biased", since these streams are boosted with CRM keyterms.
import {
  MAX_MESSAGE_BYTES,
  MAX_UTTERANCE_TEXT_CHARS,
  type UtteranceFinalV2,
  uuidv7,
  type Word,
} from "@earshot/core";

/** A word as a provider reports it, with times in ms from the socket's first sample. */
export interface ProviderWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
}

export interface UtteranceOptions {
  /** Provider ms to session ms: the socket's `baseOffsetMs` plus the provider's time. */
  readonly toSessionMs: (providerMs: number) => number;
  /** The provider's transcript, used as the text unless the utterance has to be split. */
  readonly text?: string;
  /** For a segment without words: its provider times and confidence. */
  readonly startMs?: number;
  readonly endMs?: number;
  readonly confidence?: number;
  readonly createId?: () => string;
}

const toAudioMs = (ms: number) => (Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0);

/**
 * The most an utterance may take, serialized, so its `utterance` message stays under the
 * socket's `MAX_MESSAGE_BYTES`. The rest of the message (`t`, `msgId`, `turnId`) is about 120
 * bytes; 1 KiB leaves room to spare. Word timings make an utterance's JSON much longer than its
 * text: 1,500 one-letter words are 3,000 characters of text but about 90 KB of JSON.
 */
export const MAX_UTTERANCE_BYTES = MAX_MESSAGE_BYTES - 1_024;

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).byteLength;

/** An utterance's serialized size without its words or text: ids, times, and confidence. */
const BASE_UTTERANCE_BYTES = utf8Length(
  JSON.stringify({
    utteranceId: "00000000-0000-7000-8000-000000000000",
    text: "",
    // The longest a confidence prints in JSON: 17 significant digits, as 1/3 does.
    confidence: 1 / 3,
    words: [],
    startMs: 9_999_999_999_999,
    endMs: 9_999_999_999_999,
    witness: "biased",
  }),
);

/** A confidence in [0, 1]; anything unparseable counts as 0. */
export function clampConfidence(value: unknown): number {
  const number = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * One or more `utterance.final` payloads from a provider's final segment. Usually one; more only
 * when one wouldn't fit the session socket: text past `MAX_UTTERANCE_TEXT_CHARS`, or JSON past
 * `MAX_UTTERANCE_BYTES`. Splits fall at word boundaries. An empty segment gives none.
 */
export function toUtterances(
  providerWords: readonly ProviderWord[],
  options: UtteranceOptions,
): UtteranceFinalV2[] {
  const createId = options.createId ?? uuidv7;
  const words: Word[] = [];
  for (const word of providerWords) {
    const w = word.text.trim();
    if (w === "") continue;
    const startMs = toAudioMs(options.toSessionMs(word.startMs));
    const endMs = Math.max(startMs, toAudioMs(options.toSessionMs(word.endMs)));
    words.push({ w, startMs, endMs, confidence: clampConfidence(word.confidence) });
  }
  const text = (options.text ?? "").replace(/\s+/g, " ").trim();

  if (words.length === 0) {
    if (text === "") return [];
    const startMs = toAudioMs(options.toSessionMs(options.startMs ?? 0));
    const endMs = Math.max(startMs, toAudioMs(options.toSessionMs(options.endMs ?? 0)));
    const confidence = clampConfidence(options.confidence ?? 0);
    return splitText(text).map((part) => ({
      utteranceId: createId(),
      text: part,
      confidence,
      startMs,
      endMs,
      witness: "biased" as const,
    }));
  }

  const joined = words.map((word) => word.w).join(" ");
  const wholeText = text !== "" ? text : joined;
  return fitUtterance(utterance(words, wholeText, createId), createId);
}

/**
 * Splits an utterance that the session socket would refuse into ones it accepts: each at most
 * `MAX_UTTERANCE_TEXT_CHARS` of text and `MAX_UTTERANCE_BYTES` of JSON, split at word boundaries,
 * with times and confidence from each part's own words. One that already fits comes back as is.
 * `SessionClient` runs it too, so whatever produced the utterance, nothing unsendable is queued.
 */
export function fitUtterance(
  input: UtteranceFinalV2,
  createId: () => string = uuidv7,
): UtteranceFinalV2[] {
  if (fits(input)) return [input];
  if (!input.words || input.words.length === 0) {
    return splitText(input.text).map((part) => ({ ...input, utteranceId: createId(), text: part }));
  }
  const utterances: UtteranceFinalV2[] = [];
  let chunk: Word[] = [];
  let chars = 0;
  let bytes = BASE_UTTERANCE_BYTES;
  for (const word of input.words.map(capWord)) {
    // The word in `words`, plus a comma; and in `text`, plus a space (both JSON-escaped).
    const cost = utf8Length(JSON.stringify(word)) + 1 + utf8Length(JSON.stringify(word.w)) - 1;
    const tooLong = chars + 1 + word.w.length > MAX_UTTERANCE_TEXT_CHARS;
    if (chunk.length > 0 && (tooLong || bytes + cost > MAX_UTTERANCE_BYTES)) {
      utterances.push(utterance(chunk, chunk.map((w) => w.w).join(" "), createId));
      chunk = [];
      chars = 0;
      bytes = BASE_UTTERANCE_BYTES;
    }
    chars += (chunk.length === 0 ? 0 : 1) + word.w.length;
    bytes += cost;
    chunk.push(word);
  }
  if (chunk.length > 0)
    utterances.push(utterance(chunk, chunk.map((w) => w.w).join(" "), createId));
  return utterances;
}

function fits(candidate: UtteranceFinalV2): boolean {
  return (
    candidate.text.length <= MAX_UTTERANCE_TEXT_CHARS &&
    utf8Length(JSON.stringify(candidate)) <= MAX_UTTERANCE_BYTES
  );
}

function utterance(words: Word[], text: string, createId: () => string): UtteranceFinalV2 {
  let sum = 0;
  let endMs = 0;
  for (const word of words) {
    sum += word.confidence;
    endMs = Math.max(endMs, word.endMs);
  }
  return {
    utteranceId: createId(),
    text,
    confidence: sum / words.length,
    words,
    startMs: words[0]?.startMs ?? 0,
    endMs,
    witness: "biased",
  };
}

/** A single "word" longer than the cap (no spaces) is cut, so it can still be sent. */
function capWord(word: Word): Word {
  return word.w.length <= MAX_UTTERANCE_TEXT_CHARS
    ? word
    : { ...word, w: word.w.slice(0, MAX_UTTERANCE_TEXT_CHARS) };
}

function splitText(text: string): string[] {
  if (text.length <= MAX_UTTERANCE_TEXT_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const piece of text.split(" ")) {
    const word = piece.slice(0, MAX_UTTERANCE_TEXT_CHARS);
    if (current !== "" && current.length + 1 + word.length > MAX_UTTERANCE_TEXT_CHARS) {
      parts.push(current);
      current = word;
    } else current = current === "" ? word : `${current} ${word}`;
  }
  if (current !== "") parts.push(current);
  return parts;
}
