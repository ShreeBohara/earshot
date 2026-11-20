// Fitting linker v1 on the confusable-name set's calibration split (spec WP4 steps 4 and 5), and
// the ablations (step 8). The test split is never read here.
//
// 1. Each calibration mention's candidates and features come from `candidateRows`, on the biased
//    transcript, exactly as `link` computes them. A row is positive when its record is gold.
// 2. Classes E2 and G stay out of the model. Their biased readings are, by construction, a
//    correct-looking link: E2's is a CRM name written exactly (the stream snapped a new name to
//    it), G's the open account's sibling. To a model that scores one reading's candidates, those
//    rows are label noise: they'd teach it to doubt an exact name and the open account, which
//    every other class relies on. What tells them apart is the second reading, so they join the
//    threshold search instead (WP5).
// 3. Thresholds come from out-of-fold probabilities: five folds, stratified by class, each scored
//    by a model fit on the other four. In-sample probabilities would flatter the model and set
//    the thresholds too loose. E2 and G are dealt into folds of their own the same way, so the
//    other classes' folds are WP4's. Every mention, E2 and G included, gets its final decision
//    after the witness at each grid point: its unbiased reading (`unbiasedMention`, by
//    alignment) is scored by the same fold's model and compared as `compareWitnesses` compares
//    (spec §4.6). The grid search (spec §4.4, with WP5's θ_d) then maximizes coverage subject to
//    a wrong-account rate of at most 1.5% and new-when-existing of at most 5%.
// 4. The committed model is fit on every calibration row of the classes in step 2. λ = 1.
import type { EntityRef } from "@earshot/core";
import {
  buildLinkIndex,
  CANDIDATE_SOURCES,
  type CandidateRow,
  type CandidateSource,
  canBeNew,
  candidateProbabilities,
  candidateRows,
  FEATURE_NAMES,
  type FeatureName,
  fitLogistic,
  type GridItem,
  type GridResult,
  type GridWitness,
  type LinkerParams,
  type LinkIndex,
  phrase,
  searchThresholds,
  THRESHOLD_GRID,
} from "@earshot/understanding/link";
import { readingDistance } from "@earshot/understanding/witness";
import { linkerInput, linkingCase, SEES_ALL, type Sees, shown, unbiasedMention } from "./linkers";
import type { ConfusableItem, ItemClass } from "./schema";

/** The classes only a second witness can resolve, left out of the model (but not the threshold search). */
export const WITNESS_ONLY_CLASSES: readonly ItemClass[] = ["E2", "G"];

/** The grid search's limits on calibration (spec §4.4; targets, with headroom under G1). */
export const FIT_LIMITS = { maxWrongAccountRate: 0.015, maxNewWhenExistingRate: 0.05 } as const;

/** Folds for the out-of-fold probabilities the thresholds are chosen on. */
export const FOLDS = 5;

/** The L2 penalty (spec WP4 step 3, target). */
export const LAMBDA = 1;

/**
 * What a fit uses: the model's features, the candidate sources, and what the linker is shown
 * besides the mention. An ablation that removes a signal hides it from the input too (`sees`), in
 * fitting and in prediction, so nothing derived from it (the prefilter, `rivalContext`) still
 * carries it.
 */
export interface FitConfig {
  readonly features: readonly FeatureName[];
  readonly sources: readonly CandidateSource[];
  readonly sees: Sees;
}

export const FULL_FIT: FitConfig = {
  features: FEATURE_NAMES,
  sources: CANDIDATE_SOURCES,
  sees: SEES_ALL,
};

export interface Ablation {
  readonly name: string;
  readonly label: string;
  /** What it takes away, for the report. */
  readonly removed: string;
  readonly config: FitConfig;
}

function without(
  features: readonly FeatureName[],
  sources: readonly CandidateSource[],
  hidden: Partial<Sees> = {},
): FitConfig {
  return {
    features: FEATURE_NAMES.filter((feature) => !features.includes(feature)),
    sources: CANDIDATE_SOURCES.filter((source) => !sources.includes(source)),
    sees: { ...SEES_ALL, ...hidden },
  };
}

/** The ablations in the report (spec WP4 step 8), each refit from scratch on calibration. */
export const ABLATIONS: readonly Ablation[] = [
  {
    name: "no-sound",
    label: "Without sound",
    removed:
      "Double Metaphone and the homophone list: the sound and homophone sources; phonFull, phonHead, tailCover, tieCount, rivalContext; ties by sound",
    config: without(
      ["phonFull", "phonHead", "tailCover", "tieCount", "rivalContext"],
      ["sound", "homophone"],
    ),
  },
  {
    name: "no-trigrams",
    label: "Without trigrams",
    removed: "the trigram source; trgm",
    config: without(["trgm"], ["trigram"]),
  },
  {
    name: "no-context",
    label: "Without context",
    removed:
      "the open account, earlier links, and the company said: the family source; parentCtx, focus, recent, rivalContext",
    config: without(["parentCtx", "focus", "recent", "rivalContext"], ["family"], {
      focus: false,
      recent: false,
      company: false,
    }),
  },
  {
    name: "no-focus",
    label: "Without the open account",
    removed:
      "the open account, wherever it's read: the family source, the prefilter's bonus, focus, and its part in rivalContext",
    config: without(["focus"], ["family"], { focus: false }),
  },
];

interface Prepared {
  readonly item: ConfusableItem;
  readonly rows: readonly CandidateRow[];
  /** The unbiased reading's candidates and how differently it sounds; null when it has none. */
  readonly witness: { readonly rows: readonly CandidateRow[]; readonly distance: number } | null;
  readonly newAllowed: boolean;
  readonly gold: string | null;
}

export interface FittedLinker {
  /** The parameters, without provenance (the fit script adds it). */
  readonly params: LinkerParams;
  /** The grid search's result on the out-of-fold probabilities. */
  readonly outOfFold: GridResult;
  /** Calibration mentions the model learned from. */
  readonly items: number;
  readonly rows: number;
  readonly positives: number;
  /** Gold records among the candidates, of the mentions whose gold is a CRM record. */
  readonly candidateRecall: { readonly found: number; readonly of: number };
  readonly iterations: number;
  readonly converged: boolean;
}

const vector = (row: CandidateRow, features: readonly FeatureName[]) =>
  features.map((feature) => row.features[feature]);

function modelParams(
  config: FitConfig,
  rows: readonly Prepared[],
): { params: LinkerParams; iterations: number; converged: boolean } {
  const x: number[][] = [];
  const y: number[] = [];
  for (const prepared of rows) {
    for (const row of prepared.rows) {
      x.push(vector(row, config.features));
      y.push(row.entityId === prepared.gold ? 1 : 0);
    }
  }
  const fit = fitLogistic(x, y, { lambda: LAMBDA });
  return {
    params: {
      version: "linker.v1",
      features: config.features,
      weights: Object.fromEntries(config.features.map((feature, j) => [feature, fit.weights[j]])),
      bias: fit.bias,
      sources: config.sources,
      // Placeholders until the search below sets them; `probability` doesn't read them.
      thresholds: { tauLink: 1, delta: 1, tauNew: 0, thetaD: 1 },
    },
    iterations: fit.iterations,
    converged: fit.converged,
  };
}

/** Candidates' p under a model, most likely first, ties in prefilter order (as `link` ranks them). */
function rankedRows(rows: readonly CandidateRow[], params: LinkerParams) {
  const p = candidateProbabilities(params, rows);
  const scored = rows
    .map((row, k) => ({ id: row.entityId, p: p[k] ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return { p: scored.map((entry) => entry.p), ids: scored.map((entry) => entry.id) };
}

function gridItem(prepared: Prepared, params: LinkerParams): GridItem {
  const witness: GridWitness | null = prepared.witness
    ? { ...rankedRows(prepared.witness.rows, params), distance: prepared.witness.distance }
    : null;
  return {
    ...rankedRows(prepared.rows, params),
    newAllowed: prepared.newAllowed,
    gold: prepared.gold,
    witness,
  };
}

function prepare(item: ConfusableItem, index: LinkIndex, config: FitConfig): Prepared {
  const linkingCaseOf = linkingCase(item);
  const input = shown(linkerInput(linkingCaseOf), config.sees);
  const context = { ...input, index, sources: config.sources };
  const reading = unbiasedMention(linkingCaseOf);
  // As `compareWitnesses` links it: the mention's kind, and the biased company where the
  // unbiased reading has none. A reading with no words is unavailable. An ablation that hides
  // the company said hides it from this reading too.
  const unbiased = reading && {
    text: reading.text,
    kind: input.mention.kind,
    companyText: config.sees.company
      ? (reading.companyText ?? input.mention.companyText ?? null)
      : null,
  };
  const witnessRows = unbiased ? candidateRows(unbiased, context) : [];
  return {
    item,
    rows: candidateRows(input.mention, context),
    witness:
      unbiased && phrase(unbiased.text).tokens.length > 0
        ? { rows: witnessRows, distance: readingDistance(input.mention.text, unbiased.text) }
        : null,
    newAllowed: canBeNew(input.mention.kind, input.kinds),
    gold: item.gold === "NEW" ? null : item.gold,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One mention as the threshold search sees it under a parameter set: its biased and unbiased
 * candidates' probabilities, and how differently the readings sound. `finalDecision` on it is
 * linker v1's final decision (a test holds the two together).
 */
export function gridItemFor(
  item: ConfusableItem,
  index: LinkIndex,
  params: LinkerParams,
  config: FitConfig = { features: params.features, sources: params.sources, sees: SEES_ALL },
): GridItem {
  return gridItem(prepare(item, index, config), params);
}

/**
 * Fits linker v1 (or an ablation of it) on the calibration items among `items`. Deterministic:
 * the same items, records, and config give the same parameters.
 */
export function fitLinker(
  items: readonly ConfusableItem[],
  entities: readonly EntityRef[],
  config: FitConfig = FULL_FIT,
): FittedLinker {
  const index = buildLinkIndex(entities);
  const calibration = items
    .filter((item) => item.split === "calibration")
    .map((item) => prepare(item, index, config));
  const witnessOnly = (prepared: Prepared) => WITNESS_ONLY_CLASSES.includes(prepared.item.class);
  const learnable = calibration.filter((prepared) => !witnessOnly(prepared));

  // Folds stratified by class: by class, then id, dealt round-robin; the witness-only classes
  // dealt the same way on their own, so they leave the other folds as they were.
  const fold = new Map<Prepared, number>();
  for (const group of [learnable, calibration.filter(witnessOnly)]) {
    const order = [...group].sort(
      (a, b) => compare(a.item.class, b.item.class) || compare(a.item.id, b.item.id),
    );
    order.forEach((prepared, k) => {
      fold.set(prepared, k % FOLDS);
    });
  }
  const gridItems: GridItem[] = [];
  for (let k = 0; k < FOLDS; k++) {
    const { params } = modelParams(
      config,
      learnable.filter((prepared) => fold.get(prepared) !== k),
    );
    for (const prepared of calibration) {
      if (fold.get(prepared) === k) gridItems.push(gridItem(prepared, params));
    }
  }
  const outOfFold = searchThresholds(gridItems, FIT_LIMITS, THRESHOLD_GRID);
  const final = modelParams(config, learnable);

  const withGold = learnable.filter((prepared) => prepared.gold !== null);
  return {
    params: { ...final.params, thresholds: outOfFold.thresholds },
    outOfFold,
    items: learnable.length,
    rows: learnable.reduce((sum, prepared) => sum + prepared.rows.length, 0),
    positives: learnable.reduce(
      (sum, prepared) => sum + prepared.rows.filter((row) => row.entityId === prepared.gold).length,
      0,
    ),
    candidateRecall: {
      found: withGold.filter((prepared) =>
        prepared.rows.some((row) => row.entityId === prepared.gold),
      ).length,
      of: withGold.length,
    },
    iterations: final.iterations,
    converged: final.converged,
  };
}
