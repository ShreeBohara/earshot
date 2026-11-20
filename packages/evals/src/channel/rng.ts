// The seeded PRNG behind the mishearing simulator and the confusable-name set: mulberry32, the
// same generator as @earshot/demo-crm's scripts/build.ts, so one seed gives one stream in both.
// Nothing here reads the clock or Math.random, which is what lets a test regenerate a committed
// file byte for byte.

/** mulberry32: 32 bits of state, a float in [0, 1) per call. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One item, uniformly. Throws on an empty list, which is always a caller's bug. */
  pick<T>(items: readonly T[]): T;
  /** One key, with probability proportional to its weight. Zero weights never win. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K;
  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError("pick from an empty list");
      return items[int(0, items.length - 1)] as T;
    },
    weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
      const entries = (Object.entries(weights) as [K, number][]).filter(([, w]) => w > 0);
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      if (entries.length === 0 || total <= 0) throw new RangeError("no positive weight");
      let roll = next() * total;
      for (const [key, weight] of entries) {
        roll -= weight;
        if (roll < 0) return key;
      }
      return (entries[entries.length - 1] as [K, number])[0];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

/** A seed for a named sub-stream, so one part of a generator can change without moving another's. */
export function subSeed(seed: number, name: string): number {
  // FNV-1a over the name, mixed into the seed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (seed ^ hash) >>> 0;
}
