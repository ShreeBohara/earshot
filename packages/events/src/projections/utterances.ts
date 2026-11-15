import type { Witness, Word } from "@earshot/core";
import { ProjectionError } from "../errors";
import type { Projection } from "./projection";

/** One final utterance: the `utterances` row. */
export interface UtteranceView {
  utteranceId: string;
  /** Seq and timestamp of the `utterance.final` event. */
  seq: number;
  ts: string;
  witness: Witness;
  text: string;
  confidence: number;
  startMs: number;
  endMs: number;
  /** `null` when the provider returned no word timings. */
  words: Word[] | null;
}

/** Folds `utterance.final` events into the session's utterances, in seq order. */
export const utterancesProjection: Projection<readonly UtteranceView[]> = {
  initial: [],
  apply(state, event) {
    if (event.type !== "utterance.final") return state;
    const { payload } = event;
    if (state.some((utterance) => utterance.utteranceId === payload.utteranceId)) {
      throw new ProjectionError(
        "utterances",
        event,
        `utterance ${payload.utteranceId} is already final`,
      );
    }
    return [
      ...state,
      {
        utteranceId: payload.utteranceId,
        seq: event.seq,
        ts: event.ts,
        witness: payload.witness,
        text: payload.text,
        confidence: payload.confidence,
        startMs: payload.startMs,
        endMs: payload.endMs,
        words: payload.words ?? null,
      },
    ];
  },
};
