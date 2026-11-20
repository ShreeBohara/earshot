// The decision rule (spec §4.4) and the grid search that picks its thresholds on the calibration
// split (Decision 5). With p1 and p2 the two best candidates' probabilities:
//
// - link when p1 ≥ τ_link and p1 − p2 ≥ δ;
// - new when the candidates' total probability is below τ_new, and the mention was named as a
//   company or contact the proposal type allows (a deal is never new: Phase 4 has no
//   create-deal proposal);
// - ask otherwise. With no candidate at all: new when it may be, else none.
//
// The spec writes the new rule with p1 alone. With one candidate the two agree; they part on a
// tie, where several records share the probability: three homophones at p ≈ 0.25 each have a
// low p1, yet the mention almost surely names one of them, so p1 < τ_new would call it new and
// write a duplicate. The total keeps that case an "ask", as "ties ask" means.
//
// The search maximizes coverage on calibration subject to a wrong-account rate of at most 1.5%
// and new-when-existing of at most 5% (targets, with headroom under G1's 2% and 5%). WP5 extends
// the grid with the witness's θ_d and refits.

export interface Thresholds {
  readonly tauLink: number;
  readonly delta: number;
  readonly tauNew: number;
}

export type RuleDecision = "linked" | "new" | "ask" | "none";

/**
 * The rule. `p` holds the candidates' probabilities, most likely first. Ties ask: at the top their
 * margin is 0 and δ is positive, and lower down their total keeps them from "new".
 */
export function decide(
  p: readonly number[],
  newAllowed: boolean,
  thresholds: Thresholds,
): RuleDecision {
  const [p1, p2 = 0] = p;
  if (p1 === undefined) return newAllowed ? "new" : "none";
  if (p1 >= thresholds.tauLink && p1 - p2 >= thresholds.delta) return "linked";
  if (newAllowed) {
    let total = 0;
    for (const value of p) total += value;
    if (total < thresholds.tauNew) return "new";
  }
  return "ask";
}

export interface ThresholdGrid {
  readonly tauLink: readonly number[];
  readonly delta: readonly number[];
  readonly tauNew: readonly number[];
}

function steps(from: number, to: number, step: number): number[] {
  const count = Math.round((to - from) / step);
  return Array.from({ length: count + 1 }, (_, k) => Math.round((from + k * step) * 1000) / 1000);
}

/** The spec's starting grid (§4.4): τ_link 0.70–0.98 by 0.02, δ 0.05–0.40 and τ_new 0.10–0.40 by 0.05. */
export const THRESHOLD_GRID: ThresholdGrid = {
  tauLink: steps(0.7, 0.98, 0.02),
  delta: steps(0.05, 0.4, 0.05),
  tauNew: steps(0.1, 0.4, 0.05),
};

/** One calibration mention, as the search sees it. */
export interface GridItem {
  /** The candidates' probabilities, most likely first. */
  readonly p: readonly number[];
  /** The candidates' record ids, in the same order. */
  readonly ids: readonly string[];
  readonly newAllowed: boolean;
  /** The right record, or null when the right answer is a new record. */
  readonly gold: string | null;
  /**
   * Left undecided at every grid point. WP4's fit marks the mentions only a second witness can
   * resolve this way (an ideal witness would turn them into questions); WP5 replaces that with
   * the witness itself.
   */
  readonly abstain?: boolean;
}

export interface GridLimits {
  readonly maxWrongAccountRate: number;
  readonly maxNewWhenExistingRate: number;
}

export interface GridResult {
  readonly thresholds: Thresholds;
  /** Whether the thresholds meet both limits. When no grid point does, the search returns the one with the lowest wrong-account rate. */
  readonly feasible: boolean;
  readonly items: number;
  readonly decided: number;
  readonly coverage: number;
  readonly wrongLinks: number;
  readonly wrongAccountRate: number;
  readonly newWhenExisting: number;
  readonly newWhenExistingRate: number;
  /** How many grid points were tried, and how many met both limits. */
  readonly points: number;
  readonly feasiblePoints: number;
}

function evaluate(items: readonly GridItem[], thresholds: Thresholds) {
  let decided = 0;
  let wrongLinks = 0;
  let newWhenExisting = 0;
  for (const item of items) {
    if (item.abstain) continue;
    const decision = decide(item.p, item.newAllowed, thresholds);
    if (decision === "linked") {
      decided++;
      if (item.ids[0] !== item.gold) wrongLinks++;
    } else if (decision === "new") {
      decided++;
      if (item.gold !== null) newWhenExisting++;
    }
  }
  return {
    decided,
    wrongLinks,
    newWhenExisting,
    wrongAccountRate: decided > 0 ? wrongLinks / decided : 0,
    newWhenExistingRate: decided > 0 ? newWhenExisting / decided : 0,
  };
}

type Scored = ReturnType<typeof evaluate> & { readonly thresholds: Thresholds; feasible: boolean };

/**
 * Whether `a` beats `b`. Feasible points: more coverage, then fewer wrong links, then fewer
 * duplicates, then the more cautious thresholds (higher τ_link and δ, lower τ_new). Infeasible
 * ones, when nothing is feasible: the lowest wrong-account rate, then duplicates, then coverage.
 */
function better(a: Scored, b: Scored): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  const order = a.feasible
    ? [
        b.decided - a.decided,
        a.wrongAccountRate - b.wrongAccountRate,
        a.newWhenExistingRate - b.newWhenExistingRate,
      ]
    : [
        a.wrongAccountRate - b.wrongAccountRate,
        a.newWhenExistingRate - b.newWhenExistingRate,
        b.decided - a.decided,
      ];
  order.push(
    b.thresholds.tauLink - a.thresholds.tauLink,
    b.thresholds.delta - a.thresholds.delta,
    a.thresholds.tauNew - b.thresholds.tauNew,
  );
  for (const difference of order) {
    if (Math.abs(difference) > 1e-12) return difference < 0;
  }
  return false;
}

/** Tries every grid point and returns the best (see `better`). */
export function searchThresholds(
  items: readonly GridItem[],
  limits: GridLimits,
  grid: ThresholdGrid = THRESHOLD_GRID,
): GridResult {
  let best: Scored | null = null;
  let points = 0;
  let feasiblePoints = 0;
  for (const tauLink of grid.tauLink) {
    for (const delta of grid.delta) {
      for (const tauNew of grid.tauNew) {
        const thresholds = { tauLink, delta, tauNew };
        const result = evaluate(items, thresholds);
        const feasible =
          result.wrongAccountRate <= limits.maxWrongAccountRate + 1e-12 &&
          result.newWhenExistingRate <= limits.maxNewWhenExistingRate + 1e-12;
        points++;
        if (feasible) feasiblePoints++;
        const scored: Scored = { ...result, thresholds, feasible };
        if (best === null || better(scored, best)) best = scored;
      }
    }
  }
  if (best === null) throw new RangeError("the grid is empty");
  return {
    thresholds: best.thresholds,
    feasible: best.feasible,
    items: items.length,
    decided: best.decided,
    coverage: items.length > 0 ? best.decided / items.length : 0,
    wrongLinks: best.wrongLinks,
    wrongAccountRate: best.wrongAccountRate,
    newWhenExisting: best.newWhenExisting,
    newWhenExistingRate: best.newWhenExistingRate,
    points,
    feasiblePoints,
  };
}
