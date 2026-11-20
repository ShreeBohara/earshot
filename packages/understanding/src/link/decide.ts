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
// The second witness (spec §4.6, WP5) acts after the rule: its reading of the same words is linked
// the same way, and when the two readings sound different (a code distance at or above θ_d) and
// reach different outcomes, the readings conflict. A conflict turns "linked" or "new" into "ask".
//
// The search maximizes correct decisions on calibration subject to a wrong-account rate of at
// most 1.5% and new-when-existing of at most 5% (targets, with headroom under G1's 2% and 5%),
// over τ_link, δ, τ_new, and θ_d together, with each mention's final decision after the witness.

export interface Thresholds {
  readonly tauLink: number;
  readonly delta: number;
  readonly tauNew: number;
  /**
   * θ_d: two readings of a mention sound different when the distance between their codes is at
   * least this (`readingDistance` in @earshot/understanding/witness), and only readings that
   * sound different can conflict.
   */
  readonly thetaD: number;
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

/** Whether a decision commits to an answer: a record, or a new one. Only those can be downgraded. */
export function isDecision(decision: RuleDecision): decision is "linked" | "new" {
  return decision === "linked" || decision === "new";
}

/** One witness's reading of a mention, as the linker decided it: the decision, and its record. */
export interface ReadingOutcome {
  readonly decision: RuleDecision;
  /** The linked record; null unless the decision is "linked". */
  readonly entityId: string | null;
}

/**
 * Whether two readings reached different outcomes: one links a record and the other another
 * record, "new", or no decision; one says "new" and the other doesn't. Asks and "none" are alike
 * (neither decides), so two undecided readings never differ.
 *
 * This counts an undecided unbiased reading against a decided biased one. Spec §4.6 names
 * "another record, or new against linked"; on calibration, 4 of the 10 snapped new names (E2)
 * have an unbiased reading the linker asks about, between the CRM record and "new", and only
 * this reading of the rule catches them (ADR-0028).
 */
export function outcomesDiffer(biased: ReadingOutcome, unbiased: ReadingOutcome): boolean {
  if (biased.decision === "linked" || unbiased.decision === "linked") {
    return !(
      biased.decision === "linked" &&
      unbiased.decision === "linked" &&
      biased.entityId === unbiased.entityId
    );
  }
  return isDecision(biased.decision) !== isDecision(unbiased.decision);
}

/**
 * The witness's rule (spec §4.6 steps 4 and 5): the readings conflict when they sound different,
 * at a code distance of θ_d or more, and reach different outcomes. A conflict downgrades a
 * decided biased reading to "ask" and only flags an undecided one.
 */
export function witnessConflict(
  biased: ReadingOutcome,
  unbiased: ReadingOutcome,
  distance: number,
  thetaD: number,
): boolean {
  return distance >= thetaD - 1e-12 && outcomesDiffer(biased, unbiased);
}

export interface ThresholdGrid {
  readonly tauLink: readonly number[];
  readonly delta: readonly number[];
  readonly tauNew: readonly number[];
  readonly thetaD: readonly number[];
}

function steps(from: number, to: number, step: number): number[] {
  const count = Math.round((to - from) / step);
  return Array.from({ length: count + 1 }, (_, k) => Math.round((from + k * step) * 1000) / 1000);
}

/**
 * The spec's starting grid (§4.4): τ_link 0.70–0.98 by 0.02, δ 0.05–0.40 and τ_new 0.10–0.40 by
 * 0.05; and WP5's θ_d, 0.02–0.40 by 0.02. One code edit in a 12-letter code is 0.083 and in a
 * 4-letter one 0.25, so the step resolves a single edit in any name.
 */
export const THRESHOLD_GRID: ThresholdGrid = {
  tauLink: steps(0.7, 0.98, 0.02),
  delta: steps(0.05, 0.4, 0.05),
  tauNew: steps(0.1, 0.4, 0.05),
  thetaD: steps(0.02, 0.4, 0.02),
};

/** The unbiased reading of a calibration mention, linked by the same model. */
export interface GridWitness {
  /** Its candidates' probabilities, most likely first. */
  readonly p: readonly number[];
  /** Their record ids, in the same order. */
  readonly ids: readonly string[];
  /** How differently the two readings sound (`readingDistance`), in [0, 1]. */
  readonly distance: number;
}

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
   * The second witness's reading of the same words. Null or absent when it had none, which
   * leaves the biased decision standing (an unavailable reading never conflicts).
   */
  readonly witness?: GridWitness | null;
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

/** An item's decision at a grid point, after the witness: what `link` then `compareWitnesses` give. */
export function finalDecision(item: GridItem, thresholds: Thresholds): RuleDecision {
  const decision = decide(item.p, item.newAllowed, thresholds);
  const witness = item.witness;
  if (!witness || !isDecision(decision)) return decision;
  const unbiased = decide(witness.p, item.newAllowed, thresholds);
  const conflict = witnessConflict(
    { decision, entityId: decision === "linked" ? (item.ids[0] ?? null) : null },
    { decision: unbiased, entityId: unbiased === "linked" ? (witness.ids[0] ?? null) : null },
    witness.distance,
    thresholds.thetaD,
  );
  return conflict ? "ask" : decision;
}

function evaluate(items: readonly GridItem[], thresholds: Thresholds) {
  let decided = 0;
  let wrongLinks = 0;
  let newWhenExisting = 0;
  for (const item of items) {
    const decision = finalDecision(item, thresholds);
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
 * Whether `a` beats `b`. Feasible points: more correct decisions (decided, less wrong links and
 * duplicates), then fewer wrong links, then fewer duplicates, then the more cautious thresholds
 * (higher τ_link and δ, lower τ_new and θ_d). Infeasible ones, when nothing is feasible: the
 * lowest wrong-account rate, then duplicates, then coverage.
 *
 * Correct decisions rather than all of them: within the limits, a wrong link isn't coverage worth
 * having. Counting every decision, a θ_d that lets one snapped name through as a wrong link
 * would beat one that catches it, for the one item it adds (ADR-0028).
 */
function better(a: Scored, b: Scored): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  const correct = (point: Scored) => point.decided - point.wrongLinks - point.newWhenExisting;
  const order = a.feasible
    ? [
        correct(b) - correct(a),
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
    a.thresholds.thetaD - b.thresholds.thetaD,
  );
  for (const difference of order) {
    if (Math.abs(difference) > 1e-12) return difference < 0;
  }
  return false;
}

/**
 * Tries every grid point and returns the best (see `better`). Items without a witness reading
 * are decided by the rule alone, so θ_d only matters where there's a second reading.
 */
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
        for (const thetaD of grid.thetaD) {
          const thresholds = { tauLink, delta, tauNew, thetaD };
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
