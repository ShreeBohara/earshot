// The span arithmetic of evidence clips (Phase 5 spec §4.7, WP9): a field's `audioMs` maps to the
// clip's samples as `(audioMs − startMs) × 16`, and plays padded by 250 ms on each side, clamped to
// the clip, at its start, its end, and both.
import { describe, expect, it } from "vitest";
import {
  CLIP_SAMPLE_RATE,
  clipCovers,
  clipSample,
  clipSpan,
  EVIDENCE_PAD_MS,
  spanMiddle,
  spanSeconds,
} from "../src/evidence";

/** A clip starting 10 s into the session, 4 s long: samples 0 to 64,000. */
const CLIP = { startMs: 10_000, samples: 4_000 * 16 };

describe("clipSample", () => {
  it("is (audioMs − startMs) × 16 on the session's clock", () => {
    expect(CLIP_SAMPLE_RATE).toBe(16_000);
    expect(clipSample(CLIP, 10_000)).toBe(0);
    expect(clipSample(CLIP, 11_250)).toBe(20_000);
    expect(clipSample(CLIP, 13_999)).toBe(63_984);
    expect(clipSample({ startMs: 0 }, 1)).toBe(16);
  });
});

describe("clipSpan", () => {
  it("pads 250 ms on each side of words in the middle of the clip", () => {
    expect(EVIDENCE_PAD_MS).toBe(250);
    const span = clipSpan(CLIP, [11_000, 12_000]);
    expect(span).toEqual({
      start: (11_000 - 250 - 10_000) * 16,
      end: (12_000 + 250 - 10_000) * 16,
      offsetSeconds: 0.75,
      durationSeconds: 1.5,
    });
  });

  it("clamps the padding at the clip's start", () => {
    // Words 100 ms in: the 250 ms before them would start 150 ms before the clip does.
    const span = clipSpan(CLIP, [10_100, 10_600]);
    expect(span.start).toBe(0);
    expect(span.end).toBe((10_600 + 250 - 10_000) * 16);
    expect(span.offsetSeconds).toBe(0);
    expect(span.durationSeconds).toBeCloseTo(0.85, 10);
    // Words at the very first sample.
    expect(clipSpan(CLIP, [10_000, 10_200])).toMatchObject({ start: 0, end: 450 * 16 });
  });

  it("clamps the padding at the clip's end", () => {
    // Words ending 100 ms before the clip does: the 250 ms after them would run past it.
    const span = clipSpan(CLIP, [13_400, 13_900]);
    expect(span.start).toBe((13_400 - 250 - 10_000) * 16);
    expect(span.end).toBe(CLIP.samples);
    expect(span.durationSeconds).toBeCloseTo(0.85, 10);
    // Words at the very last sample.
    expect(clipSpan(CLIP, [13_800, 14_000])).toMatchObject({
      start: 3_550 * 16,
      end: CLIP.samples,
    });
  });

  it("clamps at both edges when the words fill the clip", () => {
    const span = clipSpan(CLIP, [10_050, 13_950]);
    expect(span).toEqual({ start: 0, end: CLIP.samples, offsetSeconds: 0, durationSeconds: 4 });
  });

  it("is empty for words wholly outside the clip, and reads a reversed span the right way", () => {
    expect(clipSpan(CLIP, [20_000, 21_000])).toMatchObject({
      start: CLIP.samples,
      end: CLIP.samples,
    });
    expect(clipSpan(CLIP, [5_000, 6_000])).toMatchObject({ start: 0, end: 0, durationSeconds: 0 });
    expect(clipSpan(CLIP, [12_000, 11_000])).toEqual(clipSpan(CLIP, [11_000, 12_000]));
  });

  it("takes another pad, and an empty clip plays nothing", () => {
    expect(clipSpan(CLIP, [11_000, 12_000], 0)).toMatchObject({ start: 16_000, end: 32_000 });
    expect(clipSpan({ startMs: 0, samples: 0 }, [0, 10])).toMatchObject({ start: 0, end: 0 });
  });
});

describe("spanSeconds, spanMiddle, and clipCovers", () => {
  it("names a span in whole seconds, at least 1", () => {
    expect(spanSeconds({ durationSeconds: 0.3 })).toBe(1);
    expect(spanSeconds({ durationSeconds: 1.49 })).toBe(1);
    expect(spanSeconds({ durationSeconds: 1.5 })).toBe(2);
    expect(spanSeconds({ durationSeconds: 2.4 })).toBe(2);
  });

  it("looks a span up by its middle, in a clip that covers it from its start to its end", () => {
    expect(spanMiddle([1_000, 2_001])).toBe(1_501);
    const clip = { startMs: 10_000, durationMs: 4_000 };
    expect(clipCovers(clip, 10_000)).toBe(true);
    expect(clipCovers(clip, 14_000)).toBe(true);
    expect(clipCovers(clip, 9_999)).toBe(false);
    expect(clipCovers(clip, 14_001)).toBe(false);
  });
});
