// Which samples of an evidence clip to play for a field's words (Phase 5 spec §4.7, WP9; ADR-0036).
// Pure arithmetic, no Web Audio, so the tests can hold it at a clip's edges.
//
// A clip is one turn's audio, PCM16 at 16 kHz, and its sample k is the session audio clock's sample
// `startMs × 16 + k`: the clock `Evidence.audioMs` counts in. So a field's span maps to samples
// exactly, `(audioMs − startMs) × 16`, and playing it is `[a0 − 250 ms, a1 + 250 ms]`, clamped to
// the clip, from one AudioBuffer holding the whole clip (`source.start(0, offset, duration)`).
import { TARGET_SAMPLE_RATE } from "../capture/dsp";

/** Clips are the engine's turn audio as it holds it: 16 kHz, mono. */
export const CLIP_SAMPLE_RATE = TARGET_SAMPLE_RATE;

const SAMPLES_PER_MS = CLIP_SAMPLE_RATE / 1000;

/** How much of the audio around the words plays too, on each side (target). */
export const EVIDENCE_PAD_MS = 250;

/** Where a clip sits on the session's audio clock, and how many samples it holds. */
export interface ClipExtent {
  readonly startMs: number;
  readonly samples: number;
}

/** The part of a clip to play: samples `[start, end)`, and the same in seconds of source. */
export interface ClipSpan {
  readonly start: number;
  readonly end: number;
  /** For `AudioBufferSourceNode.start(0, offsetSeconds, durationSeconds)`. */
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The clip's sample at `audioMs` on the session's audio clock: `(audioMs − startMs) × 16`. */
export function clipSample(clip: Pick<ClipExtent, "startMs">, audioMs: number): number {
  return (audioMs - clip.startMs) * SAMPLES_PER_MS;
}

/**
 * What to play for evidence `audioMs`: the words' samples, padded by `padMs` on each side and
 * clamped to the clip. A span wholly outside the clip comes back empty (`end === start`).
 */
export function clipSpan(
  clip: ClipExtent,
  audioMs: readonly [number, number],
  padMs: number = EVIDENCE_PAD_MS,
): ClipSpan {
  const from = Math.min(audioMs[0], audioMs[1]);
  const to = Math.max(audioMs[0], audioMs[1]);
  const samples = Math.max(0, Math.floor(clip.samples));
  const start = clamp(Math.floor(clipSample(clip, from - padMs)), 0, samples);
  const end = clamp(Math.ceil(clipSample(clip, to + padMs)), start, samples);
  return {
    start,
    end,
    offsetSeconds: start / CLIP_SAMPLE_RATE,
    durationSeconds: (end - start) / CLIP_SAMPLE_RATE,
  };
}

/** A span's length in whole seconds, as the play button names it ("2 seconds"): at least 1. */
export function spanSeconds(span: Pick<ClipSpan, "durationSeconds">): number {
  return Math.max(1, Math.round(span.durationSeconds));
}

/** The ms a span is looked up by: its middle, so words at a turn's edge land in their own clip. */
export function spanMiddle(audioMs: readonly [number, number]): number {
  return Math.round((audioMs[0] + audioMs[1]) / 2);
}

/** Whether a clip covers `audioMs` on the session's clock: from its start to its end, both in. */
export function clipCovers(
  clip: { readonly startMs: number; readonly durationMs: number },
  audioMs: number,
): boolean {
  return clip.startMs <= audioMs && audioMs <= clip.startMs + clip.durationMs;
}
