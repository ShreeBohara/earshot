// Press-to-feedback timing (spec WP9: under 200 ms, target): from the input event's timestamp to
// the first frame painted after it, as a `measure` entry that tests read with a
// PerformanceObserver. The Event Timing API reports the same span for slow events; this entry
// covers fast ones too, which Event Timing skips below its 16 ms threshold.

export const PRESS_FEEDBACK_MEASURE = "earshot:ptt-feedback";

/** Call in the press handler with `event.timeStamp`. */
export function measurePressFeedback(start: number): void {
  if (typeof performance === "undefined" || typeof requestAnimationFrame === "undefined") return;
  // A task queued from the frame callback runs after that frame paints.
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        performance.measure(PRESS_FEEDBACK_MEASURE, { start, end: performance.now() });
      } catch {
        // A start in another time origin (very old browsers): skip the sample.
      }
    }, 0);
  });
}

/** The time of the first frame painted after now, for a proposal card's paint mark. */
export function afterNextPaint(callback: (at: number) => void): void {
  if (typeof requestAnimationFrame === "undefined") {
    callback(performance.now());
    return;
  }
  requestAnimationFrame(() => setTimeout(() => callback(performance.now()), 0));
}
