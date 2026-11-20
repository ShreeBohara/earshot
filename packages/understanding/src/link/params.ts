// The linker's frozen parameters (spec WP4 step 7): the model's weights over its feature list,
// the candidate sources, the thresholds, and where they came from (the calibration split's hash
// and the date). `pnpm --filter @earshot/evals linker:fit` writes params.v1.json from the
// confusable-name set's calibration split; nothing here is tuned on the test split.

import { CANDIDATE_SOURCES, type CandidateSource } from "./candidates";
import type { Thresholds } from "./decide";
import { FEATURE_NAMES, type FeatureName } from "./features";
import raw from "./params.v1.json" with { type: "json" };

/** Where a parameter set came from: the data it was fit on, and how. */
export interface LinkerProvenance {
  /** The day it was fit, YYYY-MM-DD. */
  readonly fittedAt: string;
  readonly calibration: {
    readonly set: string;
    readonly split: string;
    /** SHA-256 of the calibration split's lines, in file order, each ending in a newline. */
    readonly sha256: string;
    /** Mentions the model learned from, and the classes left out. */
    readonly items: number;
    readonly excludedClasses: readonly string[];
    /** Candidate rows, and how many of them were the gold record. */
    readonly rows: number;
    readonly positives: number;
  };
  /** The fit's settings and its out-of-fold result on calibration. */
  readonly fit: Readonly<Record<string, unknown>>;
}

export interface LinkerParams {
  /** As `proposal.created` v2's `linker` field carries it: "linker.v1". */
  readonly version: string;
  /** The model's inputs, in order. */
  readonly features: readonly FeatureName[];
  /** One weight per feature in `features`. */
  readonly weights: Readonly<Partial<Record<FeatureName, number>>>;
  readonly bias: number;
  /** The candidate sources it uses. */
  readonly sources: readonly CandidateSource[];
  readonly thresholds: Thresholds;
  /** Absent for parameters built in memory (an ablation). */
  readonly provenance?: LinkerProvenance;
}

function fail(message: string): never {
  throw new Error(`linker params: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} isn't a finite number`);
  return value;
}

function probabilityIn(value: unknown, name: string): number {
  const number = finite(value, name);
  if (number < 0 || number > 1) fail(`${name} is outside [0, 1]`);
  return number;
}

function names<T extends string>(value: unknown, known: readonly T[], what: string): T[] {
  if (!Array.isArray(value)) fail(`${what} isn't a list`);
  const out: T[] = [];
  for (const item of value) {
    if (!known.includes(item as T)) fail(`unknown ${what.replace(/s$/, "")} ${String(item)}`);
    if (out.includes(item as T)) fail(`${String(item)} is listed twice in ${what}`);
    out.push(item as T);
  }
  return out;
}

/**
 * Checks a parameter set's shape: known features and sources, a finite weight for every feature
 * and nothing else, a finite bias, and thresholds in [0, 1]. Provenance passes through as is.
 */
export function parseLinkerParams(value: unknown): LinkerParams {
  if (!isRecord(value)) fail("not an object");
  if (typeof value.version !== "string" || value.version === "") fail("no version");
  const features = names(value.features, FEATURE_NAMES, "features");
  if (!isRecord(value.weights)) fail("no weights");
  const weights: Partial<Record<FeatureName, number>> = {};
  for (const feature of features) weights[feature] = finite(value.weights[feature], feature);
  for (const key of Object.keys(value.weights)) {
    if (!features.includes(key as FeatureName)) fail(`a weight for ${key}, which isn't a feature`);
  }
  if (!isRecord(value.thresholds)) fail("no thresholds");
  const thresholds = {
    tauLink: probabilityIn(value.thresholds.tauLink, "tauLink"),
    delta: probabilityIn(value.thresholds.delta, "delta"),
    tauNew: probabilityIn(value.thresholds.tauNew, "tauNew"),
  };
  return {
    version: value.version,
    features,
    weights,
    bias: finite(value.bias, "bias"),
    sources: names(value.sources, CANDIDATE_SOURCES, "sources"),
    thresholds,
    ...(value.provenance === undefined ? {} : { provenance: value.provenance as LinkerProvenance }),
  };
}

/** Linker v1's committed parameters. */
export const LINKER_PARAMS_V1: LinkerParams = parseLinkerParams(raw);
