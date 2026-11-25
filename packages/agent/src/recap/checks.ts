// The recap's checks, in code (Phase 5 spec §4.9; ADR-0037). The model quotes; this module decides
// what's kept, so a recap can say only what the rep's own words back:
//
// 1. Every quote is located with `locateQuote` and `evidenceFor` in the session's biased
//    utterances, exactly as a proposal's fields are.
// 2. A sentence keeps the quotes that were found (at most 4, each span once), and is dropped if
//    none were. Dropped sentences are counted (`dropped`), never shown.
// 3. `weakSupport` marks a sentence whose content words overlap its located quotes under 0.5
//    (target, the faithfulness check's threshold): it may say more than they do.
// 4. Only the first kept headline is kept, and it comes first; the other sentences keep the
//    model's order.
// 5. A lens field whose quote isn't found becomes "not mentioned" (quote and evidence null), as
//    one the model left null does. Every field of the lens comes back, in the lens file's order.
// 6. A sentence whose text is shaped like a provider key is dropped too: no utterance can hold
//    one (the socket refuses them), so the model made it up, and the client refuses any server
//    message that carries one.
//
// Pure: no I/O, no clock. The trace says what happened to each sentence the model wrote, by its
// position, for the logs (counts only) and the eval (seeded bad sentences must be dropped).
import {
  containsKeyShape,
  type Evidence,
  MAX_RECAP_EVIDENCE,
  MAX_RECAP_QUOTE_CHARS,
  type RecapLens,
  type RecapSentence,
  type RecapSentenceKind,
  type UtteranceFinalV2,
} from "@earshot/core";
import { contentWordOverlap, WEAK_SUPPORT_THRESHOLD } from "@earshot/understanding/faithfulness";
import { evidenceFor, locateQuote, spanText } from "../evidence";
import type { RecapLensDefinition } from "./lenses";
import type { SubmitRecapInput } from "./schema";

/** What happened to one sentence the model wrote. */
export type SentenceFate =
  /** Kept, with at least one located quote. */
  | "kept"
  /** None of its quotes is in the transcript: dropped, and counted in `dropped`. */
  | "no_quote"
  /** A headline after the first kept one: left out (a recap has one headline). */
  | "extra_headline"
  /** Its text is shaped like a provider key: dropped, and counted in `dropped`. */
  | "key_shaped";

export interface SentenceTrace {
  /** Its position in the model's list. */
  readonly index: number;
  readonly kind: RecapSentenceKind;
  readonly fate: SentenceFate;
  /** How many of its quotes were found, and how many it gave. */
  readonly located: number;
  readonly quotes: number;
  readonly weakSupport: boolean;
}

export interface CheckedRecap {
  /** The kept sentences: the headline first, then the rest in the model's order. */
  readonly sentences: readonly RecapSentence[];
  /** Sentences with no located quote (or, never in practice, a key-shaped text). */
  readonly dropped: number;
  readonly lens: RecapLens | null;
  readonly trace: readonly SentenceTrace[];
}

/** The located evidence for a sentence's quotes, each span once, at most `MAX_RECAP_EVIDENCE`. */
function locateAll(
  quotes: readonly string[],
  utterances: readonly UtteranceFinalV2[],
): { readonly evidence: Evidence[]; readonly words: string[]; readonly located: number } {
  const evidence: Evidence[] = [];
  const words: string[] = [];
  const seen = new Set<string>();
  let located = 0;
  for (const quote of quotes) {
    const location = locateQuote(quote, utterances);
    if (!location) continue;
    located += 1;
    const key = `${location.utterance.utteranceId}:${location.span[0]}:${location.span[1]}`;
    if (seen.has(key) || evidence.length >= MAX_RECAP_EVIDENCE) continue;
    seen.add(key);
    evidence.push(evidenceFor(location));
    words.push(spanText(location));
  }
  return { evidence, words, located };
}

/**
 * The recap the model's tool input leaves once every check has run, against the session's biased
 * utterances and the lens the device chose (or none: then any lens the model filled is ignored).
 */
export function checkRecap(
  input: SubmitRecapInput,
  utterances: readonly UtteranceFinalV2[],
  lens: RecapLensDefinition | null,
): CheckedRecap {
  // Only what the production stream heard is the transcript (spec §4.2).
  const biased = utterances.filter((utterance) => utterance.witness !== "unbiased");
  const trace: SentenceTrace[] = [];
  let headline: RecapSentence | null = null;
  const rest: RecapSentence[] = [];
  let dropped = 0;
  input.sentences.forEach((sentence, index) => {
    const { evidence, words, located } = locateAll(sentence.quotes, biased);
    const text = sentence.text.trim();
    const base = { index, kind: sentence.kind, located, quotes: sentence.quotes.length };
    if (containsKeyShape(text)) {
      dropped += 1;
      trace.push({ ...base, fate: "key_shaped", weakSupport: false });
      return;
    }
    if (evidence.length === 0) {
      dropped += 1;
      trace.push({ ...base, fate: "no_quote", weakSupport: false });
      return;
    }
    const weakSupport = contentWordOverlap(text, words.join(" ")) < WEAK_SUPPORT_THRESHOLD;
    if (sentence.kind === "headline" && headline !== null) {
      trace.push({ ...base, fate: "extra_headline", weakSupport });
      return;
    }
    const kept: RecapSentence = { kind: sentence.kind, text, evidence, weakSupport };
    if (sentence.kind === "headline") headline = kept;
    else rest.push(kept);
    trace.push({ ...base, fate: "kept", weakSupport });
  });
  return {
    sentences: headline ? [headline, ...rest] : rest,
    dropped,
    lens: lens ? checkLens(input.lens, biased, lens) : null,
    trace,
  };
}

/** Every field of the lens, in its file's order: a located quote, or "not mentioned". */
function checkLens(
  given: SubmitRecapInput["lens"],
  utterances: readonly UtteranceFinalV2[],
  lens: RecapLensDefinition,
): RecapLens {
  const byField = new Map<string, string | null>();
  for (const field of given?.fields ?? []) {
    // The first answer for a field counts; a field the lens doesn't have is ignored.
    if (!byField.has(field.field)) byField.set(field.field, field.quote);
  }
  return {
    id: lens.id,
    fields: lens.fields.map((field) => {
      const quote = byField.get(field.id);
      const location = quote ? locateQuote(quote, utterances) : null;
      if (!location || !quote) return { field: field.id, quote: null, evidence: null };
      // The transcript's own words, unless folding spaces made them longer than a quote may be.
      const words = spanText(location);
      return {
        field: field.id,
        quote: words.length <= MAX_RECAP_QUOTE_CHARS ? words : quote,
        evidence: evidenceFor(location),
      };
    }),
  };
}

/** How many of a lens's fields have a located quote: "MEDDIC: 2 of 6 mentioned". */
export function lensMentioned(lens: Pick<RecapLens, "fields">): number {
  return lens.fields.filter((field) => field.evidence !== null).length;
}
