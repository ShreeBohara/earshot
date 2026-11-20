// The review clock (Phase 5 spec §4.8): how long a reviewer spent on a card, for `timing` on every
// review. Pure, on an injected clock and timers, so the tests drive it on a fake clock; the page
// feeds it focus, visibility, and input (use-review-clock.ts).
//
// - **The active card** is the one holding roving focus; on load, the first card.
// - **It runs** while the card is active, at least half visible (IntersectionObserver), and the
//   page is visible. It pauses after 30 s with no key, pointer, scroll, or touch input (target),
//   and resumes at the next input. The 30 s themselves count: nothing can know sooner that the
//   reviewer stepped away.
// - **`decisionMs`:** active time to the first decision key or click (a, e, r, s, c, 1–4, or
//   their buttons). Later ones don't move it.
// - **`handlingMs`:** active time until the decision commits: the same moment for a, r, s, and the
//   digits; the save for e; the choice for c.
// - Each card keeps its own time, so leaving it and coming back carries on where it stopped. A
//   commit hands the times over and starts the card afresh (an undo brings it back at zero).

import type { ReviewTiming } from "@earshot/core";

/** How long without input before the clock pauses (target). */
export const IDLE_PAUSE_MS = 30_000;

export interface ClockDeps {
  /** Milliseconds on a monotonic clock: `performance.now()` in the page. */
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

interface CardTime {
  /** Active time banked before the current run. */
  banked: number;
  /** When the current run started, or null while it isn't running. */
  since: number | null;
  /** Active time at the first decision, once there was one. */
  decided: number | null;
}

export class ReviewClock {
  readonly #deps: ClockDeps;
  readonly #idleMs: number;
  readonly #cards = new Map<string, CardTime>();
  readonly #visible = new Set<string>();
  #active: string | null = null;
  #pageVisible: boolean;
  #idle = false;
  #lastInput: number;
  #idleTimer: unknown = null;

  /**
   * Arms nothing yet, so a page can build it while rendering on the server: the idle timer starts
   * at the first `input()`, which the page sends as it mounts.
   */
  constructor(deps: ClockDeps, options: { pageVisible?: boolean; idleMs?: number } = {}) {
    this.#deps = deps;
    this.#idleMs = options.idleMs ?? IDLE_PAUSE_MS;
    this.#pageVisible = options.pageVisible ?? true;
    this.#lastInput = deps.now();
  }

  /** The card now holding roving focus, or null when none does. */
  setActive(proposalId: string | null): void {
    this.#update(() => {
      this.#active = proposalId;
    });
  }

  /** Whether a card is at least half on screen. */
  setVisible(proposalId: string, visible: boolean): void {
    this.#update(() => {
      if (visible) this.#visible.add(proposalId);
      else this.#visible.delete(proposalId);
    });
  }

  /** Whether the page is visible (`document.visibilityState`). */
  setPageVisible(visible: boolean): void {
    this.#update(() => {
      this.#pageVisible = visible;
    });
  }

  /** A key, pointer, scroll, or touch: the reviewer is here. Resumes a clock paused for idling. */
  input(): void {
    this.#lastInput = this.#deps.now();
    this.#armIdle();
    if (this.#idle) {
      this.#update(() => {
        this.#idle = false;
      });
    }
  }

  /** Whether `proposalId`'s clock is running now. */
  running(proposalId: string): boolean {
    return (
      this.#active === proposalId &&
      this.#visible.has(proposalId) &&
      this.#pageVisible &&
      !this.#idle
    );
  }

  /** Active time on a card so far, in ms. */
  elapsed(proposalId: string): number {
    const time = this.#cards.get(proposalId);
    if (!time) return 0;
    return time.banked + (time.since === null ? 0 : this.#deps.now() - time.since);
  }

  /** The first decision key or click on a card. Later ones change nothing. */
  decide(proposalId: string): void {
    const time = this.#card(proposalId);
    if (time.decided === null) time.decided = this.elapsed(proposalId);
  }

  /**
   * The decision committed: the card's `decisionMs` and `handlingMs`, in whole ms, and a fresh start
   * for it. A commit with no decision before it (a click that is both) decides now.
   */
  commit(proposalId: string): ReviewTiming {
    this.decide(proposalId);
    const handling = this.elapsed(proposalId);
    const decided = this.#cards.get(proposalId)?.decided ?? handling;
    this.#cards.delete(proposalId);
    // A card that stays on screen (an undo brings it back) starts again from zero.
    if (this.running(proposalId)) this.#card(proposalId).since = this.#deps.now();
    return { decisionMs: Math.round(decided), handlingMs: Math.round(handling) };
  }

  /** Stops the idle timer, for when the page goes away. */
  dispose(): void {
    if (this.#idleTimer !== null) this.#deps.clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #card(proposalId: string): CardTime {
    let time = this.#cards.get(proposalId);
    if (!time) {
      time = { banked: 0, since: null, decided: null };
      this.#cards.set(proposalId, time);
    }
    return time;
  }

  /** Banks the running card's time, applies `change`, and starts whichever card runs after it. */
  #update(change: () => void, at: number = this.#deps.now()): void {
    const before = this.#active;
    if (before !== null && this.running(before)) {
      const time = this.#card(before);
      if (time.since !== null) time.banked += Math.max(0, at - time.since);
      time.since = null;
    }
    change();
    const after = this.#active;
    if (after !== null && this.running(after)) this.#card(after).since = at;
  }

  #armIdle(): void {
    if (this.#idleTimer !== null) this.#deps.clearTimeout(this.#idleTimer);
    const due = this.#lastInput + this.#idleMs;
    this.#idleTimer = this.#deps.setTimeout(
      () => {
        this.#idleTimer = null;
        // Paused at the moment the reviewer went quiet for 30 s, not when the timer ran late.
        this.#update(
          () => {
            this.#idle = true;
          },
          Math.min(due, this.#deps.now()),
        );
      },
      Math.max(0, due - this.#deps.now()),
    );
  }
}
