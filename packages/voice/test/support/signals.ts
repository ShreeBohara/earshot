import type { Resampler } from "../../src/capture/dsp";

/** A sine at `frequency` Hz, `seconds` long, sampled at `rate`. */
export function sine(
  rate: number,
  frequency: number,
  seconds: number,
  amplitude = 0.5,
): Float32Array {
  const samples = Math.round(rate * seconds);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
}

/** A logarithmic sweep from `from` to `to` Hz, and its instantaneous frequency at time t. */
export function logSweep(rate: number, from: number, to: number, seconds: number, amplitude = 0.5) {
  const samples = Math.round(rate * seconds);
  const k = Math.log(to / from) / seconds;
  const signal = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    signal[i] = amplitude * Math.sin(((2 * Math.PI * from) / k) * (Math.exp(k * t) - 1));
  }
  return { signal, frequencyAt: (t: number) => from * Math.exp(k * t) };
}

/** Runs `input` through `resampler` in blocks of `blockSize` (the worklet's 128 by default). */
export function resampleAll(
  resampler: Resampler,
  input: Float32Array,
  blockSize = 128,
): Float32Array {
  const scratch = new Float32Array(resampler.maxOutput(Math.max(blockSize, 1)));
  const out: number[] = [];
  for (let i = 0; i < input.length; i += blockSize) {
    const block = input.subarray(i, Math.min(input.length, i + blockSize));
    const needed = resampler.maxOutput(block.length);
    const target = needed > scratch.length ? new Float32Array(needed) : scratch;
    const count = resampler.process(block, target);
    for (let k = 0; k < count; k++) out.push(target[k] ?? 0);
  }
  return Float32Array.from(out);
}

/** Runs `input` through `resampler` in blocks of varying, seeded-random sizes. */
export function resampleRagged(resampler: Resampler, input: Float32Array, seed = 7): Float32Array {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const out: number[] = [];
  for (let i = 0; i < input.length; ) {
    const size = 1 + Math.floor(next() * 700);
    const block = input.subarray(i, Math.min(input.length, i + size));
    const target = new Float32Array(resampler.maxOutput(block.length));
    const count = resampler.process(block, target);
    for (let k = 0; k < count; k++) out.push(target[k] ?? 0);
    i += size;
  }
  return Float32Array.from(out);
}

export function rmsOf(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export const db = (ratio: number) => 20 * Math.log10(ratio);

/** A tone's gain through a resampler, in dB, ignoring the filter's warm-up. */
export function toneGainDb(resampler: Resampler, frequency: number, amplitude = 0.5): number {
  const output = resampleAll(resampler, sine(resampler.inputRate, frequency, 1.5, amplitude));
  return db(rmsOf(output, 400) / (amplitude / Math.SQRT2));
}

/** Zero crossings per second: about twice a tone's frequency. */
export function zeroCrossingRate(samples: Float32Array, rate: number, from = 0): number {
  let crossings = 0;
  for (let i = from + 1; i < samples.length; i++) {
    const a = samples[i - 1] ?? 0;
    const b = samples[i] ?? 0;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings += 1;
  }
  return (crossings * rate) / (samples.length - from);
}
