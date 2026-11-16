import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUuidv7, uuidv7 } from "../src";

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = Date.UTC(2026, 10, 15, 20, 0, 0, 123); // 2026-11-15T20:00:00.123Z

function bytesOf(id: string): number[] {
  return (id.replaceAll("-", "").match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
}

function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

/** The 42-bit counter: rand_a (12 bits) and the top 30 bits of rand_b. */
function counterOf(id: string): number {
  const b = bytesOf(id);
  const high = (((b[6] ?? 0) & 0x0f) << 8) | (b[7] ?? 0);
  const low =
    (((b[8] ?? 0) & 0x3f) << 24) | ((b[9] ?? 0) << 16) | ((b[10] ?? 0) << 8) | (b[11] ?? 0);
  return high * 2 ** 30 + low;
}

const isSorted = (ids: readonly string[]) =>
  ids.every((id, i) => i === 0 || (ids[i - 1] ?? "") < id);

describe("uuidv7", () => {
  it("formats an RFC 9562 version 7 UUID that Zod accepts", () => {
    for (let i = 0; i < 1000; i++) {
      const id = uuidv7();
      expect(id).toMatch(FORMAT);
      expect(z.uuidv7().safeParse(id).success).toBe(true);
    }
  });

  it("sets the version and variant bits whatever the random bytes", () => {
    for (const fill of [0x00, 0xff, 0xa5]) {
      const next = createUuidv7({ now: () => T0, random: (bytes) => bytes.fill(fill) });
      for (let i = 0; i < 3; i++) {
        const b = bytesOf(next());
        expect((b[6] ?? 0) >> 4).toBe(0b0111);
        expect((b[8] ?? 0) >> 6).toBe(0b10);
      }
    }
  });

  it("puts the Unix time in ms in the first 48 bits", () => {
    expect(timestampOf(createUuidv7({ now: () => T0 })())).toBe(T0);
    expect(timestampOf(createUuidv7({ now: () => 0 })())).toBe(0);
    expect(timestampOf(createUuidv7({ now: () => 2 ** 48 - 1 })())).toBe(2 ** 48 - 1);
    const fromNow = timestampOf(uuidv7());
    expect(Math.abs(fromNow - Date.now())).toBeLessThan(5_000);
  });

  it("stays in order within one millisecond, by counting up", () => {
    const next = createUuidv7({ now: () => T0 });
    const ids = Array.from({ length: 10_000 }, () => next());
    expect(isSorted(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => timestampOf(id) === T0)).toBe(true);
    const counters = ids.map(counterOf);
    expect(counters.every((c, i) => i === 0 || c === (counters[i - 1] ?? 0) + 1)).toBe(true);
    expect(counters[0]).toBeLessThan(2 ** 41); // seeded with the top bit clear
  });

  it("reseeds the counter each new millisecond, with fresh random bits every time", () => {
    let ms = T0;
    const next = createUuidv7({ now: () => ms });
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i % 10 === 0) ms += 1;
      ids.push(next());
    }
    expect(isSorted(ids)).toBe(true);
    expect(new Set(ids.map((id) => id.slice(-8))).size).toBeGreaterThan(990); // the random tail
  });

  it("keeps its order when the clock goes backwards", () => {
    const clock = [T0, T0 + 5, T0 - 2_000, T0 + 1, T0 + 5, T0 + 6];
    let i = 0;
    const next = createUuidv7({ now: () => clock[i++] ?? T0 });
    const ids = clock.map(() => next());
    expect(isSorted(ids)).toBe(true);
    expect(ids.map(timestampOf)).toEqual([T0, T0 + 5, T0 + 5, T0 + 5, T0 + 5, T0 + 6]);
  });

  it("stays in order across the default generator's calls", () => {
    const ids = Array.from({ length: 5_000 }, () => uuidv7());
    expect(isSorted(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives separate generators unrelated ids on the same clock", () => {
    const a = createUuidv7({ now: () => T0 })();
    const b = createUuidv7({ now: () => T0 })();
    expect(a.slice(0, 13)).toBe(b.slice(0, 13)); // the same 48-bit time
    expect(a).not.toBe(b);
  });

  it("reads neither the clock nor randomness until called, as Workers require at import", () => {
    const now = vi.fn(() => T0);
    const random = vi.fn((bytes: Uint8Array<ArrayBuffer>) => bytes.fill(1));
    const next = createUuidv7({ now, random });
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    next();
    expect(now).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });

  it("refuses a clock that isn't a 48-bit millisecond time", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 48]) {
      expect(() => createUuidv7({ now: () => bad })()).toThrow(RangeError);
    }
  });
});
