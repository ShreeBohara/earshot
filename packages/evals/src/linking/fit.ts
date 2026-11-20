// Fitting linker v1 on the confusable-name set's calibration split (spec WP4 steps 4 and 5), and
// the ablations (step 8). The test split is never read here.
//
// 1. Each calibration mention's candidates and features come from `candidateRows`, on the biased
//    transcript, exactly as `link` computes them. A row is positive when its record is gold.
// 2. Classes E2 and G stay out of the fit. Their biased readings are, by construction, a correct-
//    looking link: E2's is a CRM name written exactly (the stream snapped a new name to it), G's
//    the open account's sibling. Only the second witness can tell them apart, so to a
//    single-witness model they're label noise; WP5 refits on every class with the witness.
// 3. Thresholds come from out-of-fold probabilities: five folds, stratified by class, each scored
//    by a model fit on the other four. In-sample probabilities would flatter the model and set
//    the thresholds too loose. The grid search (spec §4.4) then maximizes coverage subject to a
//    wrong-account rate of at most 1.5% and new-when-existing of at most 5%, with E2 and G
//    counted as asks, as an ideal second witness would leave them.
// 4. The committed model is fit on every calibration row. λ = 1.
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
  type LinkerParams,
  searchThresholds,
  THRESHOLD_GRID,
} from "@earshot/understanding/link";
import { linkerInput, linkingCase } from "./linkers";
import type { ConfusableItem, ItemClass } from "./schema";

/** The classes only a second witness can resolve, left out of a single-witness fit. */
export const WITNESS_ONLY_CLASSES: readonly ItemClass[] = ["E2", "G"];

/** The grid search's limits on calibration (spec §4.4; targets, with headroom under G1). */
export const FIT_LIMITS = { maxWrongAccountRate: 0.015, maxNewWhenExistingRate: 0.05 } as const;

/** Folds for the out-of-fold probabilities the thresholds are chosen on. */
export const FOLDS = 5;

/** The L2 penalty (spec WP4 step 3, target). */
export const LAMBDA = 1;

/** What a fit uses: the model's features and the candidate sources. */
export interface FitConfig {
  readonly features: readonly FeatureName[];
  readonly sources: readonly CandidateSource[];
}

export const FULL_FIT: FitConfig = { features: FEATURE_NAMES, sources: CANDIDATE_SOURCES };

export interface Ablation {
  readonly name: string;
  readonly label: string;
  /** What it takes away, for the report. */
  readonly removed: string;
  readonly config: FitConfig;
}

function without(features: readonly FeatureName[], sources: readonly CandidateSource[]): FitConfig {
  return {
    features: FEATURE_NAMES.filter((feature) => !features.includes(feature)),
    sources: CANDIDATE_SOURCES.filter((source) => !sources.includes(source)),
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
    removed: "the family source; parentCtx, focus, recent, rivalContext",
    config: without(["parentCtx", "focus", "recent", "rivalContext"], ["family"]),
  },
  {
    name: "no-focus",
    label: "Without the open account",
    removed: "the family source; focus",
    config: without(["focus"], ["family"]),
  },
];

interface Prepared {
  readonly item: ConfusableItem;
  readonly rows: readonly CandidateRow[];
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
      thresholds: { tauLink: 1, delta: 1, tauNew: 0 },
    },
    iterations: fit.iterations,
    converged: fit.converged,
  };
}

function gridItem(prepared: Prepared, params: LinkerParams): GridItem {
  const p = candidateProbabilities(params, prepared.rows);
  const scored = prepared.rows
    .map((row, k) => ({ id: row.entityId, p: p[k] ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return {
    p: scored.map((entry) => entry.p),
    ids: scored.map((entry) => entry.id),
    newAllowed: prepared.newAllowed,
    gold: prepared.gold,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
  const calibration = items.filter((item) => item.split === "calibration");
  const learnable: Prepared[] = calibration
    .filter((item) => !WITNESS_ONLY_CLASSES.includes(item.class))
    .map((item) => {
      const input = linkerInput(linkingCase(item));
      const rows = candidateRows(input.mention, { ...input, index, sources: config.sources });
      return {
        item,
        rows,
        newAllowed: canBeNew(input.mention.kind, input.kinds),
        gold: item.gold === "NEW" ? null : item.gold,
      };
    });

  // Folds stratified by class: by class, then id, dealt round-robin.
  const order = [...learnable].sort(
    (a, b) => compare(a.item.class, b.item.class) || compare(a.item.id, b.item.id),
  );
  const fold = new Map(order.map((prepared, k) => [prepared, k % FOLDS]));
  const gridItems: GridItem[] = [];
  for (let k = 0; k < FOLDS; k++) {
    const { params } = modelParams(
      config,
      learnable.filter((prepared) => fold.get(prepared) !== k),
    );
    for (const prepared of learnable) {
      if (fold.get(prepared) === k) gridItems.push(gridItem(prepared, params));
    }
  }
  for (const item of calibration) {
    if (WITNESS_ONLY_CLASSES.includes(item.class)) {
      gridItems.push({ p: [], ids: [], newAllowed: false, gold: null, abstain: true });
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
