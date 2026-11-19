import { describe, expect, it } from "vitest";
import {
  ATTENUATION_DB,
  createResampler,
  designLowpass,
  FirDecimator,
  FRAME_SAMPLES,
  FrameAssembler,
  floatToInt16,
  levelFromRms,
  PassthroughResampler,
  PolyphaseResampler,
  rateRatio,
  rms,
  TARGET_SAMPLE_RATE,
} from "../src/capture/dsp";
import {
  db,
  logSweep,
  resampleAll,
  resampleRagged,
  rmsOf,
  sine,
  toneGainDb,
  zeroCrossingRate,
} from "./support/signals";

// Targets (spec WP4 tests: "thresholds are targets set in the test"): flat to 6 kHz within
// 0.1 dB, and at least 65 dB down from 8 kHz, the output's Nyquist frequency, up. The design
// aims for 70 dB, so there's margin.
const PASSBAND_DB = 0.1;
const STOPBAND_DB = -65;
const PASSBAND = [100, 300, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000];
const STOPBAND = [8_000, 8_500, 9_000, 10_000, 12_000, 15_000, 18_000, 20_000];

describe.each([
  { rate: 48_000, kind: FirDecimator },
  { rate: 44_100, kind: PolyphaseResampler },
])("resampling $rate Hz to 16 kHz", ({ rate, kind }) => {
  it("picks the right path", () => {
    expect(createResampler(rate)).toBeInstanceOf(kind);
  });

  it.each(PASSBAND)("keeps a %i Hz tone within 0.1 dB", (frequency) => {
    expect(Math.abs(toneGainDb(createResampler(rate), frequency))).toBeLessThan(PASSBAND_DB);
  });

  it.each(STOPBAND)("attenuates a %i Hz tone by at least 65 dB", (frequency) => {
    expect(toneGainDb(createResampler(rate), frequency)).toBeLessThan(STOPBAND_DB);
  });

  it("is 6 dB down at the 7 kHz cutoff", () => {
    expect(toneGainDb(createResampler(rate), 7_000)).toBeCloseTo(-6.02, 1);
  });

  it("emits exactly 16,000 samples per second of input", () => {
    for (const seconds of [1, 2.5, 10]) {
      const output = resampleAll(createResampler(rate), new Float32Array(rate * seconds));
      expect(output.length).toBe(TARGET_SAMPLE_RATE * seconds);
    }
  });

  it("keeps a tone's frequency", () => {
    const output = resampleAll(createResampler(rate), sine(rate, 1_000, 1));
    expect(zeroCrossingRate(output, TARGET_SAMPLE_RATE, 400)).toBeCloseTo(2_000, -1);
  });

  it("gives the same samples however the input is split into blocks", () => {
    const input = logSweep(rate, 50, 20_000, 1).signal;
    const whole = resampleAll(createResampler(rate), input, input.length);
    expect(resampleAll(createResampler(rate), input, 128)).toEqual(whole);
    expect(resampleAll(createResampler(rate), input, 1)).toEqual(whole);
    expect(resampleRagged(createResampler(rate), input)).toEqual(whole);
  });

  it("has no discontinuity at the 128-sample block edges", () => {
    // A 1 kHz sine at 16 kHz never moves more than 2π·1000/16000 of its amplitude per sample.
    const output = resampleAll(createResampler(rate), sine(rate, 1_000, 1, 0.5), 128);
    const maxStep = 2 * Math.PI * (1_000 / TARGET_SAMPLE_RATE) * 0.5 * 1.001;
    let worst = 0;
    for (let i = 401; i < output.length; i++) {
      worst = Math.max(worst, Math.abs((output[i] ?? 0) - (output[i - 1] ?? 0)));
    }
    expect(worst).toBeLessThan(maxStep);
  });

  it("passes a sweep's speech band and removes everything above 8 kHz", () => {
    const seconds = 4;
    const amplitude = 0.5;
    const { signal, frequencyAt } = logSweep(
      rate,
      50,
      22_000 * (rate / 48_000),
      seconds,
      amplitude,
    );
    const output = resampleAll(createResampler(rate), signal);
    // 64 ms windows, from 250 Hz up, so each holds at least 16 cycles and partial cycles barely
    // move its RMS.
    const window = 1_024;
    let checkedPass = 0;
    let checkedStop = 0;
    for (let start = 512; start + window <= output.length; start += window / 4) {
      const t0 = start / TARGET_SAMPLE_RATE;
      const t1 = (start + window) / TARGET_SAMPLE_RATE;
      const level = db(rmsOf(output, start, start + window) / (amplitude / Math.SQRT2));
      if (frequencyAt(t0) >= 250 && frequencyAt(t1) < 5_500) {
        expect(Math.abs(level)).toBeLessThan(0.2);
        checkedPass += 1;
      } else if (frequencyAt(t0) > 8_500) {
        expect(level).toBeLessThan(STOPBAND_DB);
        checkedStop += 1;
      }
    }
    expect(checkedPass).toBeGreaterThan(100);
    expect(checkedStop).toBeGreaterThan(20);
  });
});

describe("other device rates", () => {
  it.each([
    { rate: 96_000, kind: FirDecimator },
    { rate: 32_000, kind: FirDecimator },
    { rate: 24_000, kind: PolyphaseResampler },
    { rate: 22_050, kind: PolyphaseResampler },
    { rate: 88_200, kind: PolyphaseResampler },
  ])(
    "handles $rate Hz: flat speech band, nothing above 8 kHz, 16k samples a second",
    ({ rate, kind }) => {
      const resampler = createResampler(rate);
      expect(resampler).toBeInstanceOf(kind);
      expect(Math.abs(toneGainDb(resampler, 1_000))).toBeLessThan(PASSBAND_DB);
      expect(toneGainDb(createResampler(rate), Math.min(9_000, rate / 2 - 500))).toBeLessThan(
        STOPBAND_DB,
      );
      expect(resampleAll(createResampler(rate), new Float32Array(rate)).length).toBe(16_000);
    },
  );

  it("passes 16 kHz through untouched", () => {
    const resampler = createResampler(16_000);
    expect(resampler).toBeInstanceOf(PassthroughResampler);
    const input = sine(16_000, 440, 0.1);
    expect(resampleAll(resampler, input)).toEqual(input);
  });

  it("upsamples 8 kHz, keeping its 0–3 kHz band", () => {
    const resampler = createResampler(8_000);
    expect(resampler).toBeInstanceOf(PolyphaseResampler);
    expect(Math.abs(toneGainDb(resampler, 1_000))).toBeLessThan(PASSBAND_DB);
    expect(resampleAll(createResampler(8_000), new Float32Array(8_000)).length).toBe(16_000);
  });

  it("approximates an odd rate with at most 1,024 branches", () => {
    const resampler = createResampler(44_056) as PolyphaseResampler;
    expect(resampler.up).toBeLessThanOrEqual(1_024);
    expect(Math.abs(resampler.up / resampler.down - 16_000 / 44_056)).toBeLessThan(1e-6);
    expect(Math.abs(toneGainDb(resampler, 1_000))).toBeLessThan(PASSBAND_DB);
  });

  it("refuses rates no device has", () => {
    expect(() => createResampler(1_000)).toThrow(RangeError);
    expect(() => createResampler(Number.NaN)).toThrow(RangeError);
  });

  it("reduces common ratios exactly", () => {
    expect(rateRatio(44_100, 16_000)).toEqual({ up: 160, down: 441 });
    expect(rateRatio(48_000, 16_000)).toEqual({ up: 1, down: 3 });
    expect(rateRatio(22_050, 16_000)).toEqual({ up: 320, down: 441 });
    expect(rateRatio(8_000, 16_000)).toEqual({ up: 2, down: 1 });
  });
});

describe("the low-pass design", () => {
  it("is symmetric, odd-length at 48 kHz, and unity at DC", () => {
    const { taps } = new FirDecimator(48_000);
    expect(taps.length % 2).toBe(1);
    expect(taps.reduce((sum, tap) => sum + tap, 0)).toBeCloseTo(1, 12);
    for (let i = 0; i < taps.length; i++)
      expect(taps[i]).toBeCloseTo(taps[taps.length - 1 - i] ?? 0, 15);
    expect(ATTENUATION_DB).toBe(70);
  });

  it("refuses impossible parameters", () => {
    expect(() => designLowpass(0, 0.1, 5)).toThrow(RangeError);
    expect(() => designLowpass(11, 0.6, 5)).toThrow(RangeError);
  });
});

describe("PCM16 conversion and levels", () => {
  it("rounds, scales asymmetrically, and clamps", () => {
    const out = new Int16Array(7);
    floatToInt16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -2]), out);
    expect([...out]).toEqual([0, 32_767, -32_768, 16_384, -16_384, 32_767, -32_768]);
  });

  it("measures RMS on floats and on PCM16", () => {
    const tone = sine(16_000, 1_000, 1, 0.5);
    expect(rms(tone)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    const pcm = new Int16Array(tone.length);
    floatToInt16(tone, pcm);
    expect(rms(pcm)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("maps RMS to the orb's 0–1 level, linear in dB from -60 dBFS", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.0001)).toBe(0);
    expect(levelFromRms(0.001)).toBeCloseTo(0, 6);
    expect(levelFromRms(Math.sqrt(0.001))).toBeCloseTo(0.5, 6);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(4)).toBe(1);
  });
});

describe("FrameAssembler", () => {
  const collect = () => {
    const frames: { pcm: Int16Array; level: number; flush: boolean }[] = [];
    const assembler = new FrameAssembler(FRAME_SAMPLES, (pcm, level, flush) =>
      frames.push({ pcm, level, flush }),
    );
    return { frames, assembler };
  };

  it("emits 512-sample (32 ms) frames, whatever the input block sizes", () => {
    const { frames, assembler } = collect();
    const input = sine(16_000, 440, 1);
    for (let i = 0; i < input.length; i += 43) assembler.push(input.subarray(i, i + 43));
    expect(frames).toHaveLength(Math.floor(16_000 / 512));
    for (const frame of frames) {
      expect(frame.pcm.length).toBe(512);
      expect(frame.flush).toBe(false);
      expect(frame.level).toBeCloseTo(0.5 / Math.SQRT2, 1);
    }
    const joined = new Int16Array(frames.length * 512);
    for (const [i, frame] of frames.entries()) joined.set(frame.pcm, i * 512);
    const expected = new Int16Array(joined.length);
    floatToInt16(input, expected, joined.length);
    expect(joined).toEqual(expected);
  });

  it("gives each frame its own buffer, so it can be transferred", () => {
    const { frames, assembler } = collect();
    assembler.push(new Float32Array(1_024));
    expect(frames[0]?.pcm.buffer).not.toBe(frames[1]?.pcm.buffer);
    expect(frames[0]?.pcm.buffer.byteLength).toBe(1_024);
  });

  it("flushes the partial frame, or an empty one, and starts fresh", () => {
    const { frames, assembler } = collect();
    assembler.push(new Float32Array(700).fill(0.25));
    assembler.flush();
    assembler.flush();
    assembler.push(new Float32Array(512));
    expect(frames.map((frame) => [frame.pcm.length, frame.flush])).toEqual([
      [512, false],
      [188, true],
      [0, true],
      [512, false],
    ]);
    expect(frames[1]?.level).toBeCloseTo(0.25, 6);
    expect(frames[2]?.level).toBe(0);
  });

  it("counts only the first `count` samples of a block", () => {
    const { frames, assembler } = collect();
    assembler.push(new Float32Array(2_000), 512);
    expect(frames).toHaveLength(1);
  });
});
