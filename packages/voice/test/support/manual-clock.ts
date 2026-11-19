import type { Clock } from "../../src/stt/socket";
import { settle } from "../../src/testing/fake-socket";

/** A clock that moves only when told, running due timers in order with microtasks settled between. */
export class ManualClock implements Clock {
  #now = 0;
  #sequence = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#sequence;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Timers waiting to fire. */
  get pending(): number {
    return this.#timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (
          timer.at <= target &&
          (timer.at < nextAt || (timer.at === nextAt && id < (nextId ?? Infinity)))
        ) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === undefined) break;
      const timer = this.#timers.get(nextId);
      this.#timers.delete(nextId);
      this.#now = nextAt;
      timer?.callback();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}
