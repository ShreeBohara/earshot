// The linking eval's metrics (spec §4.5), on a named split. All of them come from the items and
// a linker's predictions; none needs the linker itself.
//
// - Decided: the final decision is "linked" or "new", after any witness downgrade.
// - Coverage: decided ÷ items.
// - Wrong-account rate: links to a record other than gold, links when gold is NEW included,
//   ÷ decided. The bound is its one-sided 95% Clopper–Pearson upper limit.
// - New-when-existing: "new" when gold is a CRM record, ÷ decided: a duplicate rather than a
//   wrong write, capped so that "new" can't buy a lower wrong-account rate.
// - Accuracy on decided: correct decisions ÷ decided.
// - Risk–coverage and AURC: links admitted in order of falling p, as lowering τ_link from 1
//   would admit them, with every "new" decision already in. The links are the linker's own and
//   the asks only τ_link held back, which carry their best candidate's p and record
//   (`wouldLink`). Risk is the wrong-account rate. AURC is the mean risk over the admitted links
//   (ties admitted together).
// - ECE: on links with a probability, 10 equal-mass bins, |mean p − accuracy| weighted by size.
// - Divergence recall: of the decisions wrong in biased-only mode, the share the witness
//   flagged or downgraded.
// - Hidden error rate: wrong final decisions the witness didn't flag, ÷ decided.
// - Biased only: every metric again on the decisions with the witness off.
import type { LinkDecision, LinkPrediction } from "./linkers";
import { type ConfusableItem, ITEM_CLASSES, type ItemClass } from "./schema";

/** The one-sided upper confidence limit for a binomial rate: k events in n trials. */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n <= 0 || k > n) {
    throw new RangeError(`no bound for ${k} in ${n}`);
  }
  if (k === n) return 1;
  const alpha = 1 - confidence;
  // The limit is the p where P(X ≤ k) = alpha; P(X ≤ k) falls as p rises, so bisect.
  let low = k / n;
  let high = 1;
  for (let i = 0; i < 200 && high - low > 1e-12; i++) {
    const mid = (low + high) / 2;
    if (binomialCdf(k, n, mid) > alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** P(X ≤ k) for X ~ Binomial(n, p), summed in log space so large n doesn't underflow. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let logTerm = n * logQ; // log P(X = 0)
  let logSum = logTerm;
  for (let i = 0; i < k; i++) {
    logTerm += Math.log((n - i) / (i + 1)) + logP - logQ;
    const high = Math.max(logSum, logTerm);
    logSum = high + Math.log(Math.exp(logSum - high) + Math.exp(logTerm - high));
  }
  return Math.min(1, Math.exp(logSum));
}

export interface ReliabilityBin {
  readonly count: number;
  readonly pMin: number;
  readonly pMax: number;
  readonly meanP: number;
  readonly accuracy: number;
}

export interface RiskPoint {
  /** Links with p at or above this are admitted. */
  readonly threshold: number;
  readonly coverage: number;
  /** Null when nothing is decided at this threshold. */
  readonly risk: number | null;
}

export interface LinkingMetrics {
  readonly items: number;
  readonly decided: number;
  readonly coverage: number;
  readonly linked: number;
  readonly wrongLinks: number;
  readonly wrongAccountRate: number | null;
  readonly bound: number | null;
  readonly newDecisions: number;
  readonly newWhenExisting: number;
  readonly newWhenExistingRate: number | null;
  readonly correct: number;
  readonly accuracyOnDecided: number | null;
  /** Decisions that are the class's best decision (see `asExpected`). */
  readonly asExpected: number;
  readonly aurc: number | null;
  readonly ece: number | null;
  readonly flagged: number;
  readonly hiddenErrors: number;
  readonly hiddenErrorRate: number | null;
  /** Null without a witness, or when biased-only mode got nothing wrong. */
  readonly divergenceRecall: number | null;
}

/** An item and a linker's prediction for it. */
export interface Scored {
  readonly item: ConfusableItem;
  readonly prediction: LinkPrediction;
}

export type Mode = "final" | "biased";

export const isDecided = (decision: LinkDecision) =>
  decision.decision === "linked" || decision.decision === "new";

export const isWrongLink = (decision: LinkDecision, gold: string) =>
  decision.decision === "linked" && decision.entityId !== gold;

export const isNewWhenExisting = (decision: LinkDecision, gold: string) =>
  decision.decision === "new" && gold !== "NEW";

export const isCorrect = (decision: LinkDecision, gold: string) =>
  (decision.decision === "linked" && decision.entityId === gold) ||
  (decision.decision === "new" && gold === "NEW");

/**
 * Whether a decision is the item's best decision: a link to gold for "link", "new" for "new",
 * and anything undecided for "ask" (v0's "none", no target, abstains as an "ask" does).
 */
export const asExpected = (decision: LinkDecision, item: ConfusableItem) =>
  item.expect === "link"
    ? decision.decision === "linked" && decision.entityId === item.gold
    : item.expect === "new"
      ? decision.decision === "new"
      : !isDecided(decision);

const ratio = (count: number, of: number) => (of > 0 ? count / of : null);

function decisionOf(scored: Scored, mode: Mode): LinkDecision {
  return mode === "final" ? scored.prediction.final : scored.prediction.biased;
}

/** Whether the witness acted on an item: a flag, or a decided biased reading turned to "ask". */
function witnessActed(scored: Scored): boolean {
  const { biased, final, flagged } = scored.prediction;
  return flagged || (isDecided(biased) && final.decision === "ask");
}

/**
 * Links admitted by falling p (null counts as 1), with every "new" in from the start: the
 * linker's links, and its asks that carry a held-back link (`wouldLink`, at the ask's p).
 */
export function riskCoverage(
  rows: readonly Scored[],
  mode: Mode,
  thresholds: readonly number[] = RISK_THRESHOLDS,
): { readonly points: RiskPoint[]; readonly aurc: number | null } {
  const decisions = rows.map((row) => ({ row, decision: decisionOf(row, mode) }));
  const base = decisions.filter(({ decision }) => decision.decision === "new").length;
  const links = decisions
    .flatMap(({ row, decision }) => {
      if (decision.decision === "linked") {
        return [{ p: decision.p ?? 1, wrong: isWrongLink(decision, row.item.gold) }];
      }
      if (decision.decision === "ask" && decision.wouldLink && decision.p !== null) {
        return [{ p: decision.p, wrong: decision.wouldLink !== row.item.gold }];
      }
      return [];
    })
    .sort((a, b) => b.p - a.p);
  const points = thresholds.map((threshold) => {
    const admitted = links.filter((link) => link.p >= threshold);
    const decided = base + admitted.length;
    const wrong = admitted.filter((link) => link.wrong).length;
    return {
      threshold,
      coverage: rows.length > 0 ? decided / rows.length : 0,
      risk: ratio(wrong, decided),
    };
  });
  if (links.length === 0) return { points, aurc: null };
  let riskSum = 0;
  let admitted = 0;
  let wrong = 0;
  for (let start = 0; start < links.length; ) {
    let end = start;
    while (end < links.length && links[end]?.p === links[start]?.p) end++;
    const group = links.slice(start, end);
    admitted += group.length;
    wrong += group.filter((link) => link.wrong).length;
    riskSum += group.length * (wrong / (base + admitted));
    start = end;
  }
  return { points, aurc: riskSum / links.length };
}

export const RISK_THRESHOLDS: readonly number[] = [
  1, 0.99, 0.98, 0.97, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0,
];

/** Equal-mass bins of the links that have a probability: by p, ties by id. */
export function reliability(
  rows: readonly Scored[],
  mode: Mode,
  bins = 10,
): { readonly bins: ReliabilityBin[]; readonly ece: number | null } {
  const links = rows
    .map((row) => ({ row, decision: decisionOf(row, mode) }))
    .filter(({ decision }) => decision.decision === "linked" && decision.p !== null)
    .map(({ row, decision }) => ({
      id: row.item.id,
      p: decision.p as number,
      correct: decision.entityId === row.item.gold,
    }))
    .sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (links.length === 0) return { bins: [], ece: null };
  const out: ReliabilityBin[] = [];
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const slice = links.slice(
      Math.floor((b * links.length) / bins),
      Math.floor(((b + 1) * links.length) / bins),
    );
    if (slice.length === 0) continue;
    const meanP = slice.reduce((sum, link) => sum + link.p, 0) / slice.length;
    const accuracy = slice.filter((link) => link.correct).length / slice.length;
    out.push({
      count: slice.length,
      pMin: slice[0]?.p ?? 0,
      pMax: slice.at(-1)?.p ?? 0,
      meanP,
      accuracy,
    });
    ece += (slice.length / links.length) * Math.abs(meanP - accuracy);
  }
  return { bins: out, ece };
}

/** Every metric, for one mode, over some rows. `witness` says whether the linker ran one. */
export function linkingMetrics(
  rows: readonly Scored[],
  mode: Mode,
  witness: boolean,
): LinkingMetrics {
  let decided = 0;
  let linked = 0;
  let wrongLinks = 0;
  let newDecisions = 0;
  let newWhenExisting = 0;
  let correct = 0;
  let expected = 0;
  let flagged = 0;
  let hiddenErrors = 0;
  let biasedWrong = 0;
  let caught = 0;
  for (const row of rows) {
    const decision = decisionOf(row, mode);
    const gold = row.item.gold;
    const acted = mode === "final" && witnessActed(row);
    if (asExpected(decision, row.item)) expected++;
    if (acted) flagged++;
    if (isDecided(decision)) {
      decided++;
      if (isCorrect(decision, gold)) correct++;
      else if (!acted) hiddenErrors++;
    }
    if (decision.decision === "linked") linked++;
    if (isWrongLink(decision, gold)) wrongLinks++;
    if (decision.decision === "new") newDecisions++;
    if (isNewWhenExisting(decision, gold)) newWhenExisting++;
    const biased = row.prediction.biased;
    if (isDecided(biased) && !isCorrect(biased, gold)) {
      biasedWrong++;
      if (witnessActed(row)) caught++;
    }
  }
  const curve = riskCoverage(rows, mode);
  return {
    items: rows.length,
    decided,
    coverage: rows.length > 0 ? decided / rows.length : 0,
    linked,
    wrongLinks,
    wrongAccountRate: ratio(wrongLinks, decided),
    bound: decided > 0 ? clopperPearsonUpper(wrongLinks, decided) : null,
    newDecisions,
    newWhenExisting,
    newWhenExistingRate: ratio(newWhenExisting, decided),
    correct,
    accuracyOnDecided: ratio(correct, decided),
    asExpected: expected,
    aurc: curve.aurc,
    ece: reliability(rows, mode).ece,
    flagged,
    hiddenErrors,
    hiddenErrorRate: ratio(hiddenErrors, decided),
    divergenceRecall: witness && mode === "final" ? ratio(caught, biasedWrong) : null,
  };
}

export interface LinkingReport {
  readonly linker: string;
  readonly witness: boolean;
  readonly set: string;
  readonly split: string;
  readonly final: LinkingMetrics;
  readonly biasedOnly: LinkingMetrics;
  readonly perClass: Readonly<Record<ItemClass, LinkingMetrics>>;
  readonly perClassBiasedOnly: Readonly<Record<ItemClass, LinkingMetrics>>;
  readonly riskCoverage: readonly RiskPoint[];
  readonly reliability: readonly ReliabilityBin[];
}

/** Pairs items with predictions by id; every item needs exactly one. */
export function score(
  items: readonly ConfusableItem[],
  predictions: readonly LinkPrediction[],
): Scored[] {
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  if (byId.size !== predictions.length) throw new Error("two predictions share an id");
  return items.map((item) => {
    const prediction = byId.get(item.id);
    if (!prediction) throw new Error(`no prediction for ${item.id}`);
    return { item, prediction };
  });
}

export function linkingReport(
  rows: readonly Scored[],
  meta: { linker: string; witness: boolean; set: string; split: string },
): LinkingReport {
  const perClass = (mode: Mode) =>
    Object.fromEntries(
      ITEM_CLASSES.map((itemClass) => [
        itemClass,
        linkingMetrics(
          rows.filter((row) => row.item.class === itemClass),
          mode,
          meta.witness,
        ),
      ]),
    ) as Record<ItemClass, LinkingMetrics>;
  return {
    ...meta,
    final: linkingMetrics(rows, "final", meta.witness),
    biasedOnly: linkingMetrics(rows, "biased", meta.witness),
    perClass: perClass("final"),
    perClassBiasedOnly: perClass("biased"),
    riskCoverage: riskCoverage(rows, "final").points,
    reliability: reliability(rows, "final").bins,
  };
}
