// UUIDv7 (RFC 9562, section 5.7), with no dependency: ids that sort by the millisecond they were
// made in, for event envelopes, client messages, and ticket ids. It runs wherever
// `crypto.getRandomValues` does: Workers, Node, and browsers. It reads the clock and randomness
// only when called, never at import, because Workers forbid both in global scope.
//
// Layout, most significant bits first:
//
//   48 bits  Unix time in ms
//    4 bits  version, 0b0111
//   12 bits  counter, high bits   ─┐ a 42-bit counter (RFC 9562 section 6.2, method 1), seeded at
//    2 bits  variant, 0b10         │ random each new millisecond with its top bit clear, and
//   30 bits  counter, low bits    ─┘ incremented for each id within the same millisecond
//   32 bits  random, fresh for every id
//
// Ids from one generator therefore always sort in the order they were made. When the clock goes
// backwards the generator keeps the last timestamp and counts on; when the counter would
// overflow it moves the timestamp one millisecond ahead (both allowed by section 6.2).

export interface Uuidv7Options {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Fills `bytes` with random bytes. Defaults to `crypto.getRandomValues`. */
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

const COUNTER_LIMIT = 2 ** 42; // the counter runs from a 41-bit seed up to 2^42 - 1
const MAX_TIMESTAMP = 2 ** 48 - 1;
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * Makes a UUIDv7 generator with its own monotonic state. Tests pass a fixed clock and random
 * source; everything else uses `uuidv7`.
 */
export function createUuidv7(options: Uuidv7Options = {}): () => string {
  const now = options.now ?? (() => Date.now());
  const random =
    options.random ??
    ((bytes: Uint8Array<ArrayBuffer>) => {
      crypto.getRandomValues(bytes);
    });
  let lastMs = -1;
  let counter = 0;

  return () => {
    const entropy = new Uint8Array(10); // 6 bytes for a fresh seed, 4 for the random tail
    random(entropy);
    const ms = now();
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMESTAMP) {
      throw new RangeError(`uuidv7: the clock returned ${ms}, not a 48-bit millisecond time`);
    }
    if (ms > lastMs) {
      lastMs = ms;
      counter = seed(entropy);
    } else if (++counter >= COUNTER_LIMIT) {
      // The same millisecond (or an earlier one): count on, borrowing the next ms on overflow.
      lastMs += 1;
      counter = seed(entropy);
    }
    if (lastMs > MAX_TIMESTAMP) throw new RangeError("uuidv7: the timestamp overflowed 48 bits");

    const high = Math.floor(counter / 2 ** 30); // 12 bits
    const low = counter % 2 ** 30; // 30 bits
    const hex = [
      Math.floor(lastMs / 2 ** 40),
      Math.floor(lastMs / 2 ** 32),
      Math.floor(lastMs / 2 ** 24),
      Math.floor(lastMs / 2 ** 16),
      Math.floor(lastMs / 2 ** 8),
      lastMs,
      0x70 | (high >>> 8),
      high,
      0x80 | (low >>> 24),
      low >>> 16,
      low >>> 8,
      low,
      entropy[6] ?? 0,
      entropy[7] ?? 0,
      entropy[8] ?? 0,
      entropy[9] ?? 0,
    ]
      .map((value) => HEX[value & 0xff]) // `& 0xff` keeps the low byte, even of a 48-bit number
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** A 41-bit counter seed from the first six entropy bytes: 2^41 increments before overflow. */
function seed(entropy: Uint8Array<ArrayBuffer>): number {
  return (
    ((entropy[0] ?? 0) & 0x01) * 2 ** 40 +
    (entropy[1] ?? 0) * 2 ** 32 +
    (entropy[2] ?? 0) * 2 ** 24 +
    (entropy[3] ?? 0) * 2 ** 16 +
    (entropy[4] ?? 0) * 2 ** 8 +
    (entropy[5] ?? 0)
  );
}

/** A new UUIDv7, in lowercase. Ids from this process sort in the order they were made. */
export const uuidv7: () => string = createUuidv7();
