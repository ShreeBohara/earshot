// Faults by seed (Phase 6 spec §4.2, G2a): the reference CRM can fail a request at three points,
// each with its own chance, drawn from a seeded generator so a failing run replays exactly. The
// outbox's chaos test (WP3) runs a thousand jobs through them. Worker-safe.

/** Where a request fails. */
export type FaultPoint =
  /** The request never reaches the CRM: nothing changes, and the call fails as a network error. */
  | "before"
  /** The CRM commits the request, but its answer never arrives: the call fails as a network error. */
  | "after_commit"
  /**
   * The CRM commits and answers, but the answer is cut off after its status: the call gets the
   * status, and reading its body fails, so the adapter can't learn what it made.
   */
  | "after_response";

/** Each point's chance of failing a request, from 0 to 1, and the seed that decides which. */
export interface FaultPlan {
  readonly seed: number;
  readonly before?: number;
  readonly afterCommit?: number;
  readonly afterResponse?: number;
  /** Fail only requests that change something (not GET), which is where faults hurt. */
  readonly writesOnly?: boolean;
}

/** mulberry32: a small, fast, seeded generator of numbers in [0, 1); the same seed, the same run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A fault plan as a function of each request, in order: the point it fails at, or null. One draw
 * per request it applies to, so the schedule depends only on the seed and the order of requests.
 */
export function faultSchedule(plan: FaultPlan): (method: string) => FaultPoint | null {
  const next = seeded(plan.seed);
  const before = plan.before ?? 0;
  const afterCommit = plan.afterCommit ?? 0;
  const afterResponse = plan.afterResponse ?? 0;
  if (
    before < 0 ||
    afterCommit < 0 ||
    afterResponse < 0 ||
    before + afterCommit + afterResponse > 1
  ) {
    throw new RangeError("fault chances are each 0 or more, and 1 at most together");
  }
  return (method) => {
    if (plan.writesOnly && method === "GET") return null;
    const draw = next();
    if (draw < before) return "before";
    if (draw < before + afterCommit) return "after_commit";
    if (draw < before + afterCommit + afterResponse) return "after_response";
    return null;
  };
}
