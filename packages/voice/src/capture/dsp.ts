// The capture DSP (spec WP4 step 2): a low-pass FIR and a resampler from the AudioContext's
// native rate to 16 kHz, framing into 512-sample PCM16 frames, and levels. Pure and
// dependency-free, so the pcm16-capture worklet runs it on the audio thread and Vitest runs it in
// Node. Every stage keeps its state between calls, so audio split into 128-frame render quanta
// comes out exactly as if it had been processed in one piece: no clicks at block edges.
//
// The filter passes 0–6 kHz and stops everything from 8 kHz (the 16 kHz Nyquist) up, by at least
// ATTENUATION_DB, so nothing aliases into the speech band. At 48 kHz that's 105 taps, about 1 ms of
// delay. Output scales with the input's lower rate: an 8 kHz device gets 0–3 kHz.

/** The rate every speech-to-text adapter receives. */
export const TARGET_SAMPLE_RATE = 16_000;
/** One capture frame: 512 samples, 32 ms at 16 kHz, which is also Silero v5 and v6's frame size. */
export const FRAME_SAMPLES = 512;
/** Stopband attenuation the filters are designed for, in dB. */
export const ATTENUATION_DB = 70;
/** The passband edge, as a fraction of the lower of the two rates (6 kHz at 16 kHz). */
export const PASSBAND_EDGE = 0.375;
/** The stopband edge, as a fraction of the lower of the two rates: its Nyquist frequency. */
export const STOPBAND_EDGE = 0.5;
/** The most polyphase branches a resampler builds; stranger rates are approximated. */
export const MAX_PHASES = 1024;

/** Turns `inputRate` audio into `outputRate` audio, one block at a time. */
export interface Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** The most samples `process` can write for an input of `inputLength` samples. */
  maxOutput(inputLength: number): number;
  /** Filters `input` and writes the resampled samples to `output`, returning how many it wrote. */
  process(input: Float32Array, output: Float32Array): number;
}

/** The zeroth-order modified Bessel function of the first kind, for the Kaiser window. */
export function besselI0(x: number): number {
  const quarterSquare = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= quarterSquare / (k * k);
    sum += term;
    if (term < sum * 1e-15) break;
  }
  return sum;
}

/** Kaiser's β for a stopband attenuation in dB. */
export function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21) {
    return 0.5842 * (attenuationDb - 21) ** 0.4 + 0.07886 * (attenuationDb - 21);
  }
  return 0;
}

/** Kaiser's estimate of the taps a low-pass needs for a transition band `transition` wide. */
export function kaiserTaps(attenuationDb: number, transition: number): number {
  return Math.ceil((attenuationDb - 7.95) / (14.36 * transition)) + 1;
}

/**
 * A linear-phase, windowed-sinc low-pass FIR: `taps` coefficients, `cutoff` as a fraction of the
 * sample rate (between 0 and 0.5), a Kaiser window with `beta`, and `gain` at DC.
 */
export function designLowpass(taps: number, cutoff: number, beta: number, gain = 1): Float64Array {
  if (!Number.isInteger(taps) || taps < 1) throw new RangeError(`taps must be a positive integer`);
  if (!(cutoff > 0 && cutoff < 0.5)) throw new RangeError(`cutoff must be between 0 and 0.5`);
  const h = new Float64Array(taps);
  const middle = (taps - 1) / 2;
  const windowScale = besselI0(beta);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const t = n - middle;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const r = middle === 0 ? 0 : t / middle;
    const value = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / windowScale;
    h[n] = value;
    sum += value;
  }
  for (let n = 0; n < taps; n++) h[n] = ((h[n] ?? 0) / sum) * gain;
  return h;
}

/** The low-pass edges for converting between two rates, in Hz. */
function filterEdges(inputRate: number, outputRate: number) {
  const lowRate = Math.min(inputRate, outputRate);
  const passband = PASSBAND_EDGE * lowRate;
  const stopband = STOPBAND_EDGE * lowRate;
  return { cutoff: (passband + stopband) / 2, transition: stopband - passband };
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/**
 * `outputRate / inputRate` as `up / down` with `up` at most `maxUp`: exact for every common rate
 * (44.1 kHz is 160/441), and the closest continued-fraction convergent for any other.
 */
export function rateRatio(
  inputRate: number,
  outputRate: number,
  maxUp = MAX_PHASES,
): { up: number; down: number } {
  const divisor = greatestCommonDivisor(outputRate, inputRate);
  const up = outputRate / divisor;
  const down = inputRate / divisor;
  if (up <= maxUp) return { up, down };
  // Convergents p/q of the continued fraction for outputRate / inputRate.
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let x = outputRate / inputRate;
  let best = { up: 1, down: Math.max(1, Math.round(inputRate / outputRate)) };
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(x);
    const [p2, q2] = [a * p1 + p0, a * q1 + q0];
    if (p2 > maxUp) break;
    if (p2 > 0 && q2 > 0) best = { up: p2, down: q2 };
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    const fraction = x - a;
    if (fraction < 1e-12) break;
    x = 1 / fraction;
  }
  return best;
}

/** Copies its input: for a device that already runs at 16 kHz. */
export class PassthroughResampler implements Resampler {
  readonly inputRate: number;
  readonly outputRate: number;

  constructor(rate: number) {
    this.inputRate = rate;
    this.outputRate = rate;
  }

  maxOutput(inputLength: number): number {
    return inputLength;
  }

  process(input: Float32Array, output: Float32Array): number {
    output.set(input);
    return input.length;
  }
}

/**
 * Low-pass filters, then keeps every `factor`th sample: the exact path from 48 kHz (factor 3),
 * and from 32 or 96 kHz. Only the kept samples are computed. The filter's history and the
 * decimation phase carry across calls.
 */
export class FirDecimator implements Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  readonly factor: number;
  readonly taps: Float64Array;
  #buffer: Float32Array;
  readonly #history: number;
  /** How far into the next block the next kept sample is. */
  #skip = 0;

  constructor(inputRate: number, outputRate = TARGET_SAMPLE_RATE) {
    const factor = inputRate / outputRate;
    if (!Number.isInteger(factor) || factor < 2) {
      throw new RangeError(`FirDecimator needs an integer factor, not ${inputRate}/${outputRate}`);
    }
    const { cutoff, transition } = filterEdges(inputRate, outputRate);
    let count = kaiserTaps(ATTENUATION_DB, transition / inputRate);
    if (count % 2 === 0) count += 1; // odd: a whole-sample delay
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.factor = factor;
    this.taps = designLowpass(count, cutoff / inputRate, kaiserBeta(ATTENUATION_DB));
    this.#history = count - 1;
    this.#buffer = new Float32Array(this.#history + 128);
  }

  maxOutput(inputLength: number): number {
    return Math.ceil(inputLength / this.factor) + 1;
  }

  process(input: Float32Array, output: Float32Array): number {
    const history = this.#history;
    if (this.#buffer.length < history + input.length) {
      const grown = new Float32Array(history + input.length);
      grown.set(this.#buffer.subarray(0, history));
      this.#buffer = grown;
    }
    const buffer = this.#buffer;
    buffer.set(input, history);
    const taps = this.taps;
    const end = history + input.length;
    let written = 0;
    let newest = history + this.#skip;
    for (; newest < end; newest += this.factor) {
      // The newest sample in the window is buffer[newest]; the oldest is buffer[newest - history].
      let sum = 0;
      for (let k = 0; k <= history; k++) sum += (taps[k] ?? 0) * (buffer[newest - k] ?? 0);
      output[written++] = sum;
    }
    this.#skip = newest - end;
    buffer.copyWithin(0, input.length, end);
    return written;
  }
}

/**
 * Rational resampling by `up / down` with a polyphase filter bank: the path for 44.1 kHz (160/441)
 * and every other rate that isn't a multiple of 16 kHz, upsampling included. Each output sample
 * runs one branch of the prototype low-pass, so no zeros are ever multiplied.
 */
export class PolyphaseResampler implements Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  readonly up: number;
  readonly down: number;
  /** Taps per branch: how many input samples each output sample reads. */
  readonly tapsPerPhase: number;
  /** Branch `p`'s taps are `phases[p * tapsPerPhase + k]`, for input sample `newest - k`. */
  readonly #phases: Float32Array;
  #buffer: Float32Array;
  readonly #history: number;
  /** The next output's position, in 1/up input samples, from the current block's first sample. */
  #position = 0;

  constructor(inputRate: number, outputRate = TARGET_SAMPLE_RATE) {
    const { up, down } = rateRatio(inputRate, outputRate);
    const { cutoff, transition } = filterEdges(inputRate, outputRate);
    const tapsPerPhase = kaiserTaps(ATTENUATION_DB, transition / inputRate);
    const upsampledRate = inputRate * up;
    const prototype = designLowpass(
      up * tapsPerPhase,
      cutoff / upsampledRate,
      kaiserBeta(ATTENUATION_DB),
      up,
    );
    const phases = new Float32Array(up * tapsPerPhase);
    for (let p = 0; p < up; p++) {
      for (let k = 0; k < tapsPerPhase; k++) {
        phases[p * tapsPerPhase + k] = prototype[p + k * up] ?? 0;
      }
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.up = up;
    this.down = down;
    this.tapsPerPhase = tapsPerPhase;
    this.#phases = phases;
    this.#history = tapsPerPhase - 1;
    this.#buffer = new Float32Array(this.#history + 128);
  }

  maxOutput(inputLength: number): number {
    return Math.ceil((inputLength * this.up) / this.down) + 1;
  }

  process(input: Float32Array, output: Float32Array): number {
    const history = this.#history;
    if (this.#buffer.length < history + input.length) {
      const grown = new Float32Array(history + input.length);
      grown.set(this.#buffer.subarray(0, history));
      this.#buffer = grown;
    }
    const buffer = this.#buffer;
    buffer.set(input, history);
    const { up, down, tapsPerPhase } = this;
    const phases = this.#phases;
    const limit = input.length * up;
    let written = 0;
    let position = this.#position;
    for (; position < limit; position += down) {
      const newest = history + Math.floor(position / up);
      const base = (position % up) * tapsPerPhase;
      let sum = 0;
      for (let k = 0; k < tapsPerPhase; k++) {
        sum += (phases[base + k] ?? 0) * (buffer[newest - k] ?? 0);
      }
      output[written++] = sum;
    }
    this.#position = position - limit;
    buffer.copyWithin(0, input.length, history + input.length);
    return written;
  }
}

/**
 * The resampler for a device rate: a copy at 16 kHz, decimation for a multiple of 16 kHz (48 kHz
 * is 3:1), and the polyphase resampler for anything else. Read the rate from
 * `AudioContext.sampleRate` at run time; never assume 48 kHz.
 */
export function createResampler(inputRate: number, outputRate = TARGET_SAMPLE_RATE): Resampler {
  const rate = Math.round(inputRate);
  if (!(rate >= 3_000 && rate <= 768_000)) {
    throw new RangeError(`unsupported capture sample rate ${inputRate}`);
  }
  if (rate === outputRate) return new PassthroughResampler(rate);
  if (rate % outputRate === 0) return new FirDecimator(rate, outputRate);
  return new PolyphaseResampler(rate, outputRate);
}

/**
 * Converts float samples in [-1, 1] to PCM16, rounding and clamping, into `output`. Returns the
 * number of samples converted.
 */
export function floatToInt16(
  input: Float32Array,
  output: Int16Array,
  count = input.length,
): number {
  const n = Math.min(count, input.length, output.length);
  for (let i = 0; i < n; i++) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    output[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return n;
}

/** The root-mean-square level of float samples in [-1, 1], or of PCM16 scaled to that range. */
export function rms(samples: Float32Array | Int16Array, count = samples.length): number {
  const n = Math.min(count, samples.length);
  if (n === 0) return 0;
  const scale = samples instanceof Int16Array ? 1 / 0x8000 : 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const sample = (samples[i] ?? 0) * scale;
    sum += sample * sample;
  }
  return Math.sqrt(sum / n);
}

/**
 * The orb's mic level, 0 to 1, from an RMS level: -60 dBFS or quieter is 0 and full scale is 1,
 * linear in dB in between, which is closer to loudness than the raw RMS.
 */
export function levelFromRms(level: number): number {
  if (!(level > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60));
}

/** Receives each finished frame: its PCM16 samples, their RMS level, and whether a flush made it. */
export type FrameListener = (pcm: Int16Array<ArrayBuffer>, level: number, flush: boolean) => void;

/**
 * Collects 16 kHz float samples into PCM16 frames of `frameSize` samples. Every frame gets its
 * own buffer, so it can be transferred. `flush()` emits whatever is buffered at once, as a shorter
 * frame (or an empty one), so a push-to-talk release doesn't wait up to 32 ms for the next frame.
 */
export class FrameAssembler {
  readonly frameSize: number;
  readonly #onFrame: FrameListener;
  readonly #pending: Float32Array;
  #filled = 0;
  #sumSquares = 0;

  constructor(frameSize: number, onFrame: FrameListener) {
    if (!Number.isInteger(frameSize) || frameSize < 1) throw new RangeError("frameSize");
    this.frameSize = frameSize;
    this.#onFrame = onFrame;
    this.#pending = new Float32Array(frameSize);
  }

  /** Adds the first `count` samples of `samples`. */
  push(samples: Float32Array, count = samples.length): void {
    const n = Math.min(count, samples.length);
    for (let i = 0; i < n; i++) {
      const sample = samples[i] ?? 0;
      this.#pending[this.#filled++] = sample;
      this.#sumSquares += sample * sample;
      if (this.#filled === this.frameSize) this.#emit(false);
    }
  }

  /** Emits the partial frame now, even if it's empty. */
  flush(): void {
    this.#emit(true);
  }

  #emit(flush: boolean): void {
    const count = this.#filled;
    const pcm = new Int16Array(count);
    floatToInt16(this.#pending, pcm, count);
    const level = count === 0 ? 0 : Math.sqrt(this.#sumSquares / count);
    this.#filled = 0;
    this.#sumSquares = 0;
    this.#onFrame(pcm, level, flush);
  }
}
