import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES } from "../src/capture/dsp";
import { PcmRingBuffer } from "../src/capture/ring-buffer";
import {
  MESSAGE_SAMPLES,
  MIN_MESSAGE_SAMPLES,
  msToSamples,
  RING_SECONDS,
  SpeechStream,
  samplesToMs,
} from "../src/capture/speech-stream";

/** PCM whose every sample is its own absolute index (mod 2^15), so reads can be checked exactly. */
function ramp(from: number, length: number): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = (from + i) % 32_768;
  return out;
}

describe("PcmRingBuffer", () => {
  it("reads back what it holds, by absolute index", () => {
    const ring = new PcmRingBuffer(10);
    ring.write(ramp(0, 4));
    ring.write(ramp(4, 3));
    expect(ring.start).toBe(0);
    expect(ring.end).toBe(7);
    expect([...ring.read(2, 6)]).toEqual([2, 3, 4, 5]);
    expect([...ring.read(5)]).toEqual([5, 6]);
  });

  it("drops the oldest samples once full, and reads across the wrap", () => {
    const ring = new PcmRingBuffer(10);
    for (let i = 0; i < 25; i += 3) ring.write(ramp(i, 3));
    expect(ring.end).toBe(27);
    expect(ring.start).toBe(17);
    expect([...ring.read(0)]).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    expect([...ring.read(19, 23)]).toEqual([19, 20, 21, 22]);
  });

  it("keeps only the tail of a write bigger than the ring", () => {
    const ring = new PcmRingBuffer(5);
    ring.write(ramp(0, 12));
    expect([ring.start, ring.end]).toEqual([7, 12]);
    expect([...ring.read(0)]).toEqual([7, 8, 9, 10, 11]);
  });

  it("returns nothing for an empty or out-of-range read", () => {
    const ring = new PcmRingBuffer(5);
    ring.write(ramp(0, 3));
    expect(ring.read(3)).toHaveLength(0);
    expect(ring.read(10, 20)).toHaveLength(0);
    expect(ring.read(2, 1)).toHaveLength(0);
  });

  it("numbers from a later start index, holding nothing before it, and wraps from there", () => {
    const ring = new PcmRingBuffer(10, 25);
    expect([ring.start, ring.end]).toEqual([25, 25]);
    ring.write(ramp(25, 4));
    expect([...ring.read(0)]).toEqual([25, 26, 27, 28]);
    ring.write(ramp(29, 9));
    expect([ring.start, ring.end]).toEqual([28, 38]);
    expect([...ring.read(0)]).toEqual([28, 29, 30, 31, 32, 33, 34, 35, 36, 37]);
    expect(() => new PcmRingBuffer(10, -1)).toThrow(RangeError);
  });

  it("holds 60 s of 16 kHz PCM16 in about 1.9 MB", () => {
    const stream = new SpeechStream();
    expect(RING_SECONDS).toBe(60);
    stream.append(new Int16Array(16_000 * 61));
    expect(stream.end - stream.start).toBe(960_000);
    expect(960_000 * 2).toBe(1_920_000);
  });
});

describe("SpeechStream", () => {
  it("batches 32 ms frames into 64 ms messages", () => {
    expect(FRAME_SAMPLES).toBe(512);
    expect(MESSAGE_SAMPLES).toBe(2 * FRAME_SAMPLES);
    const stream = new SpeechStream();
    let cursor = 0;
    const sent: Int16Array[] = [];
    for (let frame = 0; frame < 7; frame++) {
      stream.append(ramp(frame * 512, 512));
      const result = stream.take(cursor, false);
      cursor = result.cursor;
      sent.push(...result.messages);
    }
    // Seven frames: three whole messages, with one frame waiting.
    expect(sent.map((message) => message.length)).toEqual([1_024, 1_024, 1_024]);
    expect(cursor).toBe(3_072);
    expect([...(sent[1] ?? []).slice(0, 3)]).toEqual([1_024, 1_025, 1_026]);
  });

  it("sends the remainder on a flush, padded with silence to the 20 ms minimum", () => {
    const stream = new SpeechStream();
    stream.append(ramp(0, 1_024 + 100));
    const result = stream.take(0, true);
    expect(result.messages.map((message) => message.length)).toEqual([1_024, MIN_MESSAGE_SAMPLES]);
    expect(result.padded).toBe(MIN_MESSAGE_SAMPLES - 100);
    const tail = result.messages[1] ?? new Int16Array();
    expect([...tail.slice(98, 102)]).toEqual([1_122, 1_123, 0, 0]);
    // The padding joined the stream, so the clocks stay in step.
    expect(stream.end).toBe(1_024 + MIN_MESSAGE_SAMPLES);
    expect(result.cursor).toBe(stream.end);
  });

  it("doesn't pad a remainder that already meets the minimum, or an empty one", () => {
    const stream = new SpeechStream();
    stream.append(ramp(0, 512));
    expect(stream.take(0, true).messages.map((m) => m.length)).toEqual([512]);
    expect(stream.take(512, true)).toMatchObject({ messages: [], padded: 0, cursor: 512 });
    expect(stream.end).toBe(512);
  });

  it("replays from any cursor faster than real time, in 64 ms messages", () => {
    const stream = new SpeechStream();
    stream.append(ramp(0, 16_000 * 5));
    const result = stream.take(16_000 * 2, true);
    const replayed = result.messages.reduce((sum, message) => sum + message.length, 0);
    // 48,000 samples: 46 whole messages and an 896-sample remainder, already over 20 ms.
    expect(replayed).toBe(16_000 * 3);
    expect(result.messages).toHaveLength(47);
    expect(result.messages.at(-1)?.length).toBe(896);
    expect(result.padded).toBe(0);
    expect(result.messages[0]?.[0]).toBe((16_000 * 2) % 32_768);
  });

  it("reports samples that fell off the ring before a replay reached them", () => {
    const stream = new SpeechStream({ ringSeconds: 1 });
    stream.append(new Int16Array(16_000 * 3));
    const result = stream.take(0, false);
    expect(result.skipped).toBe(32_000);
    expect(result.messages.reduce((sum, message) => sum + message.length, 0)).toBe(15_360);
  });

  it("starts at a later sample of the session clock, and never replays from before it", () => {
    const stream = new SpeechStream({ startSample: 48_000 });
    expect([stream.start, stream.end]).toEqual([48_000, 48_000]);
    stream.append(ramp(48_000, 2_048));
    const result = stream.take(0, false);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.[0]).toBe(48_000 % 32_768);
    expect(result.cursor).toBe(50_048);
  });

  it("converts between samples and session audio ms at 16 kHz", () => {
    expect(samplesToMs(16_000)).toBe(1_000);
    expect(samplesToMs(17)).toBe(1);
    expect(msToSamples(1_000)).toBe(16_000);
    expect(msToSamples(64)).toBe(1_024);
  });

  it("rejects a minimum larger than a message", () => {
    expect(() => new SpeechStream({ messageSamples: 100, minMessageSamples: 200 })).toThrow(
      RangeError,
    );
  });
});
