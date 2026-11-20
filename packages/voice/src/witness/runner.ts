// The second witness (Phase 4 spec §4.6, WP9; ADR-0029): an independent transcript of each turn,
// made in the browser on the user's own provider key and without keyterms, which SessionDO
// compares with the biased stream at every name. The audio and the key go from the browser to the
// provider; Earshot gets only the transcript, as a `witness` message.
//
// A runner transcribes one turn's audio. Its words come back on the session's audio clock, so they
// line up with the biased stream's: the turn's start plus each word's time in the turn's audio.
import type { UtteranceFinalV2, WitnessReason } from "@earshot/core";

/** The second witness's provider and model (spec decision 6). */
export const WITNESS_PROVIDER = "groq";
export const WITNESS_MODEL = "whisper-large-v3-turbo";

/** A push-to-talk turn's audio runs this long past the release (target). */
export const TURN_AUDIO_TAIL_MS = 200;

/** A turn's audio longer than this isn't sent: the witness skips it as `too_long` (target). */
export const MAX_TURN_AUDIO_MS = 120_000;

/**
 * A turn with less audio than this isn't sent at all: Whisper invents text on short or silent
 * audio (spec §8), the provider bills 10 s regardless, and a tap that short names nothing.
 */
export const MIN_WITNESS_AUDIO_MS = 1_000;

/** `utterance.final` v2 from the second witness: the only kind a `witness` message carries. */
export type UnbiasedUtterance = UtteranceFinalV2 & { readonly witness: "unbiased" };

/** Why a runner has no transcript: what `turn.witnessed` records as the reason. */
export type WitnessFailure = Extract<
  WitnessReason,
  "no_key" | "rate_limited" | "provider_error" | "timeout"
>;

export type WitnessResult =
  | {
      /** The turn's unbiased transcript, labelled `witness: "unbiased"`, on the session's clock. */
      readonly utterance: UnbiasedUtterance;
      /**
       * The audio sent, in ms: what the `usage` message reports. The price table applies the
       * provider's minimum per request (`minBilledMsPerRequest`).
       */
      readonly audioMs: number;
      /** How long the request took, retries included, by the runner's clock. */
      readonly latencyMs: number;
    }
  | { readonly failure: WitnessFailure; readonly latencyMs: number };

export interface TranscribeOptions {
  /** Where the turn's audio starts on the session's audio clock, in ms. */
  readonly turnStartMs: number;
  /** Aborting it gives up on the request (the session is over). */
  readonly signal?: AbortSignal;
}

/** Transcribes one turn's audio: PCM16, mono, 16 kHz. Never throws; a failure is a result. */
export interface WitnessRunner {
  readonly provider: string;
  readonly model: string;
  transcribe(pcm16: Int16Array, options: TranscribeOptions): Promise<WitnessResult>;
}

/** True for a result with a transcript. */
export function isTranscribed(
  result: WitnessResult,
): result is Extract<WitnessResult, { utterance: UnbiasedUtterance }> {
  return "utterance" in result;
}
