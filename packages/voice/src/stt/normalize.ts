// Normalization to `utterance.final` v2 (spec WP4 step 5): each word becomes `{ w, startMs,
// endMs, confidence }` on the session's audio clock, the utterance's confidence is the mean of
// its words', and `witness` is "biased", since these streams are boosted with CRM keyterms.
import { MAX_UTTERANCE_TEXT_CHARS, type UtteranceFinalV2, uuidv7, type Word } from "@earshot/core";

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

/** A confidence in [0, 1]; anything unparseable counts as 0. */
export function clampConfidence(value: unknown): number {
  const number = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * One or more `utterance.final` payloads from a provider's final segment. Usually one; more only
 * when the text would pass the session socket's `MAX_UTTERANCE_TEXT_CHARS`, split at word
 * boundaries. An empty segment gives none.
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
  if (wholeText.length <= MAX_UTTERANCE_TEXT_CHARS) return [utterance(words, wholeText, createId)];

  const utterances: UtteranceFinalV2[] = [];
  let chunk: Word[] = [];
  let length = 0;
  for (const word of words.map(capWord)) {
    if (chunk.length > 0 && length + 1 + word.w.length > MAX_UTTERANCE_TEXT_CHARS) {
      utterances.push(utterance(chunk, chunk.map((w) => w.w).join(" "), createId));
      chunk = [];
      length = 0;
    }
    length += (chunk.length === 0 ? 0 : 1) + word.w.length;
    chunk.push(word);
  }
  if (chunk.length > 0)
    utterances.push(utterance(chunk, chunk.map((w) => w.w).join(" "), createId));
  return utterances;
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
