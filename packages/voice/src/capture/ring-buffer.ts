// A fixed-size ring of PCM16 samples, addressed by absolute sample index: sample `i` is the
// `i`th sample ever written, so callers can ask for "everything from sample 48,000 on" without
// tracking where the ring wrapped. Old samples drop off the front once it's full.

export class PcmRingBuffer {
  readonly capacity: number;
  readonly #samples: Int16Array;
  #end = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.#samples = new Int16Array(capacity);
  }

  /** The index of the oldest sample still held. */
  get start(): number {
    return Math.max(0, this.#end - this.capacity);
  }

  /** The index one past the newest sample: the number of samples ever written. */
  get end(): number {
    return this.#end;
  }

  /** Appends `pcm`, dropping the oldest samples once the ring is full. */
  write(pcm: Int16Array): void {
    let source = pcm;
    if (source.length > this.capacity) {
      this.#end += source.length - this.capacity;
      source = source.subarray(source.length - this.capacity);
    }
    const offset = this.#end % this.capacity;
    const firstPart = Math.min(source.length, this.capacity - offset);
    this.#samples.set(source.subarray(0, firstPart), offset);
    if (firstPart < source.length) this.#samples.set(source.subarray(firstPart), 0);
    this.#end += source.length;
  }

  /**
   * A copy of samples `[from, to)`, clipped to what the ring still holds: asking for samples that
   * already dropped off returns only the part that's left (check `start` first to tell).
   */
  read(from: number, to = this.#end): Int16Array {
    const first = Math.max(from, this.start);
    const last = Math.min(to, this.#end);
    if (last <= first) return new Int16Array(0);
    const out = new Int16Array(last - first);
    const offset = first % this.capacity;
    const firstPart = Math.min(out.length, this.capacity - offset);
    out.set(this.#samples.subarray(offset, offset + firstPart));
    if (firstPart < out.length)
      out.set(this.#samples.subarray(0, out.length - firstPart), firstPart);
    return out;
  }
}
