// The live smoke eval's pacing (Phase 4 WP11 step 1), on a fake clock: a slow start, then at most
// 60 requests in any minute, through every request the extractor makes.
import { describe, expect, it } from "vitest";
import { createPacer, pacedFetch, paceGapMs, SMOKE_PACE } from "../src/smoke";

/** A clock that only moves when something waits on it. */
function fakeClock() {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number, signal?: AbortSignal | null) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      at += ms;
    },
    waits,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** The most starts any 60 s window holds. */
function busiestMinute(starts: readonly number[]): number {
  let most = 0;
  for (const [i, start] of starts.entries()) {
    const inWindow = starts.slice(i).filter((at) => at < start + 60_000).length;
    most = Math.max(most, inWindow);
  }
  return most;
}

describe("paceGapMs", () => {
  it("starts at once, then climbs from 10 a minute to 60 over the first ten gaps", () => {
    expect(paceGapMs(0)).toBe(0);
    expect(paceGapMs(1)).toBe(6_000);
    expect(paceGapMs(2)).toBe(4_000);
    expect(paceGapMs(5)).toBe(2_000);
    for (let k = 1; k < 11; k++) expect(paceGapMs(k + 1)).toBeLessThanOrEqual(paceGapMs(k));
    expect(paceGapMs(11)).toBe(1_000);
    expect(paceGapMs(500)).toBe(1_000);
    expect(SMOKE_PACE.maxPerMinute).toBeLessThanOrEqual(60);
  });
});

describe("createPacer", () => {
  it("never lets more than 60 requests start in any minute, and takes about 24 s to reach full pace", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    for (let i = 0; i < 200; i++) {
      await pacer.acquire();
      starts.push(clock.now());
    }
    expect(pacer.started).toBe(200);
    expect(busiestMinute(starts)).toBeLessThanOrEqual(60);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBe(6_000);
    const ramp = starts[11] as number;
    expect(ramp).toBeGreaterThan(20_000);
    expect(ramp).toBeLessThan(30_000);
    // At full pace: one a second.
    expect((starts[100] as number) - (starts[99] as number)).toBe(1_000);
  });

  it("waits for nothing when the requests themselves are slower than the pace", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    await pacer.acquire();
    clock.advance(10_000);
    await pacer.acquire();
    expect(clock.waits).toEqual([]);
  });

  it("holds the minute's count at a lower limit too, and queues callers that ask at once", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      maxPerMinute: 5,
      startPerMinute: 5,
      now: clock.now,
      sleep: clock.sleep,
    });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, () => pacer.acquire().then(() => starts.push(clock.now()))),
    );
    expect(starts).toHaveLength(12);
    expect(busiestMinute(starts)).toBeLessThanOrEqual(5);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("gives up a wait when its signal aborts, without holding up the next caller", async () => {
    const pacer = createPacer({ startPerMinute: 1, maxPerMinute: 1 });
    await pacer.acquire();
    const controller = new AbortController();
    const waiting = pacer.acquire(controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(pacer.started).toBe(1);
    // An already-aborted signal is refused at once.
    await expect(pacer.acquire(controller.signal)).rejects.toThrow("stopped");
  });
});

describe("pacedFetch", () => {
  it("waits for the pacer before every request, and counts each", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ now: clock.now, sleep: clock.sleep });
    const seen: number[] = [];
    const fetch = pacedFetch(
      (async () => {
        seen.push(clock.now());
        return new Response("{}");
      }) as typeof globalThis.fetch,
      pacer,
    );
    for (let i = 0; i < 3; i++) await fetch("https://api.invalid/v1/messages", { method: "POST" });
    expect(seen).toEqual([0, 6_000, 10_000]);
    expect(pacer.started).toBe(3);
  });
});
