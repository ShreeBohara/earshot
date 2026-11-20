// What lab/scripts/render_debriefs.py writes, as the e2e test reads it (spec WP11 step 2):
// `lab/.cache/wavs/manifest.json`, which maps each script to its WAV, and next to each WAV a
// `<hash>.timing.json` with where every turn's speech starts and ends. The e2e test presses
// push-to-talk at each turn's start and releases 200 ms after its end, and hands the same turns
// to the fake speech-to-text adapter.
//
// A committed sample (fixtures/timing.sample.json), written by the renderer with a stub voice,
// keeps the two languages honest: pytest checks the renderer still writes it byte for byte, and
// a Vitest test checks these schemas accept it.
import { z } from "zod";
import { KokoroVoice } from "./schema";

export const RENDER_SAMPLE_RATE = 48_000;
/**
 * The pseudo model file a `render_debriefs.py --stub` manifest names (its `STUB_MODEL_NAME`):
 * tones instead of speech, for checking the e2e plumbing without the model. CI's eval refuses
 * such a manifest, and no baseline is ever taken from one.
 */
export const STUB_RENDER_MODEL = "STUB-TONES-NOT-FOR-EVALUATION";
/** Digital silence after the last turn, so the fake microphone's last buffer is all zeros. */
export const RENDER_TAIL_MS = 1_000;

const Ms = z.int().nonnegative();
const RenderHash = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * A word's approximate place in the WAV. Kokoro reports no word timings, so each turn's span is
 * spread over its words by character count, by the same rule as `spreadWords` in
 * `@earshot/voice/testing`; the fake adapter computes the same times when given only the span.
 */
export const TimedWord = z.strictObject({ w: z.string().min(1), startMs: Ms, endMs: Ms });
export type TimedWord = z.infer<typeof TimedWord>;

export const TimedTurn = z.strictObject({
  index: z.int().nonnegative(),
  /** Where the turn's speech starts and ends in the WAV, in ms. */
  startMs: Ms,
  endMs: Ms,
  text: z.string().min(1),
  words: z.array(TimedWord).min(1),
});
export type TimedTurn = z.infer<typeof TimedTurn>;

/** `<hash>.timing.json`. */
export const DebriefTiming = z.strictObject({
  version: z.literal(1),
  hash: RenderHash,
  voice: KokoroVoice,
  sampleRate: z.literal(RENDER_SAMPLE_RATE),
  /** The whole WAV, tail included. */
  durationMs: z.int().positive(),
  tailMs: z.int().min(500),
  turns: z.array(TimedTurn).min(1),
});
export type DebriefTiming = z.infer<typeof DebriefTiming>;

/** `manifest.json`: what one render produced, and from what. */
export const RenderManifest = z.strictObject({
  version: z.literal(1),
  /** The renderer's version (`RENDERER_VERSION`); part of every hash. */
  renderer: z.int().positive(),
  /** The model files' SHA-256s, by file name. */
  model: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  /** The versions of the packages that shape the audio. */
  packages: z.record(z.string(), z.string().min(1)),
  scripts: z.record(
    z.string().regex(/^d\d{3}$/),
    z.strictObject({
      hash: RenderHash,
      /** File names in the manifest's directory. */
      wav: z.string().regex(/^[0-9a-f]{32}\.wav$/),
      timing: z.string().regex(/^[0-9a-f]{32}\.timing\.json$/),
      durationMs: z.int().positive(),
    }),
  ),
});
export type RenderManifest = z.infer<typeof RenderManifest>;

/** Whether the render is `--stub` tones rather than Kokoro speech. */
export function isStubRender(manifest: RenderManifest): boolean {
  return Object.hasOwn(manifest.model, STUB_RENDER_MODEL);
}
