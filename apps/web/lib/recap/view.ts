// The recap as the panel lays it out (Phase 5 spec §4.9, WP10), pure, so tests read every case
// directly: the headline, the next steps, and the commitments, each sentence with the words its
// evidence points at; the lens's collapsed line and its fields; or the one line saying why there's
// no recap.

import { RECAP_LENSES } from "@earshot/agent/recap/lenses";
import type { Evidence, RecapCreatedV1, RecapSentence } from "@earshot/core";
import { droppedLine, lensSummary, NO_RECAP_COPY } from "./copy";

/** The words an evidence span covers, from its utterance's text; null when that isn't loaded. */
export type WordsOf = (evidence: Evidence) => string | null;

/** A text lookup by utterance id, as words: the slice of the utterance the span covers. */
export function wordsFrom(texts: Readonly<Record<string, string>>): WordsOf {
  return (evidence) => {
    const text = texts[evidence.utteranceId] ?? texts[evidence.utteranceId.toLowerCase()];
    if (text === undefined) return null;
    const words = text.slice(evidence.span[0], evidence.span[1]).trim();
    return words === "" ? null : words;
  };
}

export interface RecapLine {
  /** Its position among the recap's sentences: the panel's ids are built from it. */
  readonly index: number;
  readonly text: string;
  readonly weakSupport: boolean;
  /** Each piece of evidence's words, where they're loaded, with the span they came from. */
  readonly heard: readonly { readonly words: string; readonly evidence: Evidence }[];
}

export interface RecapLensView {
  /** "MEDDIC: 2 of 6 mentioned". */
  readonly summary: string;
  readonly fields: readonly {
    readonly id: string;
    readonly label: string;
    /** The rep's words, or null: "Not mentioned". */
    readonly words: string | null;
    readonly evidence: Evidence | null;
  }[];
}

export type RecapView =
  | {
      readonly kind: "created";
      readonly headline: RecapLine | null;
      readonly nextSteps: readonly RecapLine[];
      readonly commitments: readonly RecapLine[];
      /** "1 sentence was left out…", or null when none was. */
      readonly dropped: string | null;
      readonly lens: RecapLensView | null;
    }
  | { readonly kind: "none"; readonly line: string };

function line(sentence: RecapSentence, index: number, wordsOf: WordsOf): RecapLine {
  return {
    index,
    text: sentence.text,
    weakSupport: sentence.weakSupport,
    heard: sentence.evidence.flatMap((evidence) => {
      const words = wordsOf(evidence);
      return words === null ? [] : [{ words, evidence }];
    }),
  };
}

/** The recap as the panel shows it. */
export function recapView(
  recap: Pick<RecapCreatedV1, "outcome" | "reason" | "sentences" | "dropped" | "lens">,
  wordsOf: WordsOf,
): RecapView {
  if (recap.outcome !== "created") {
    return { kind: "none", line: NO_RECAP_COPY[recap.reason ?? "provider_error"] };
  }
  const lines = recap.sentences.map((sentence, index) => line(sentence, index, wordsOf));
  const of = (kind: RecapSentence["kind"]) =>
    lines.filter((_, index) => recap.sentences[index]?.kind === kind);
  const definition = recap.lens ? RECAP_LENSES[recap.lens.id] : null;
  const lens =
    recap.lens && definition
      ? {
          summary: lensSummary(
            definition.label,
            recap.lens.fields.filter((field) => field.evidence !== null).length,
            recap.lens.fields.length,
          ),
          fields: recap.lens.fields.map((field) => ({
            id: field.field,
            label:
              definition.fields.find((candidate) => candidate.id === field.field)?.label ??
              field.field,
            words: field.evidence ? (field.quote ?? wordsOf(field.evidence)) : null,
            evidence: field.evidence,
          })),
        }
      : null;
  return {
    kind: "created",
    headline: of("headline")[0] ?? null,
    nextSteps: of("next_step"),
    commitments: of("commitment"),
    dropped: recap.dropped > 0 ? droppedLine(recap.dropped) : null,
    lens,
  };
}

/** Every utterance id the recap's evidence points at: what the inbox loads the words of. */
export function recapUtteranceIds(recap: Pick<RecapCreatedV1, "sentences" | "lens">): string[] {
  const ids = new Set<string>();
  for (const sentence of recap.sentences) {
    for (const evidence of sentence.evidence) ids.add(evidence.utteranceId.toLowerCase());
  }
  for (const field of recap.lens?.fields ?? []) {
    if (field.evidence) ids.add(field.evidence.utteranceId.toLowerCase());
  }
  return [...ids];
}
