// Comparing the two witnesses at one mention (spec §4.6 steps 3 to 5): the unbiased reading is
// linked with the same index and context as the biased one, and the two conflict when they sound
// different (a code distance at or above θ_d) and reach different outcomes (`witnessConflict` in
// ../link/decide.ts, which the threshold search applies too).
//
// - A conflict on a target the linker decided ("linked" or "new") downgrades it to "ask". The
//   candidates merge both readings' choices: the old target first, then the unbiased reading's
//   choice, then the rest by p, at most 3 records plus "new".
// - A conflict on an undecided target, or on another field (a contact's `name`), flags it.
// - No unbiased reading, or one with no words, is "unavailable": no conflict and no flag.
//
// Agreement never raises p in v1.
import {
  codeSimilarity,
  isDecision,
  type LinkContext,
  type LinkResult,
  link,
  type MentionInput,
  phrase,
  type ReadingOutcome,
  type TargetCandidate,
  witnessConflict,
} from "../link";

/** The field name a target's flags carry (`RiskFlagV2.field`); no proposal type has a field called target. */
export const TARGET_FIELD = "target";

/** A downgrade keeps at most this many records among its candidates, plus "new". */
export const MAX_DOWNGRADE_RECORDS = 3;

/** A flag to add to a proposal: `RiskFlagV2`'s shape. */
export interface WitnessFlag {
  readonly kind: "witness_conflict";
  readonly field: string;
}

/** A target turned into a question: `TargetDowngrade`'s shape. */
export interface TargetDowngrade {
  readonly decision: "ask";
  /** The old target first; at most 3 records and "new" (a null id). */
  readonly candidates: readonly TargetCandidate[];
}

export type WitnessOutcome = "agree" | "conflict" | "unavailable";

/** The unbiased witness's words for a mention (`readUnbiased`), and for the company said with it. */
export interface UnbiasedMention {
  readonly text: string;
  /**
   * The unbiased reading of the company said in the same breath. Absent or null when there was
   * none or the witness had no reading of it; the biased mention's company then stands, since
   * it's context.
   */
  readonly companyText?: string | null;
}

export interface WitnessInput {
  /** `target` for a proposal's target mention, or the field the name is in, such as `name`. */
  readonly field?: string;
  /** The biased mention, as the linker was given it. */
  readonly mention: MentionInput;
  /** What the linker decided on it. */
  readonly biased: LinkResult;
  /** The unbiased reading, or null when the second witness has none. */
  readonly unbiased: UnbiasedMention | null;
}

export interface WitnessComparison {
  readonly field: string;
  readonly outcome: WitnessOutcome;
  /** How differently the readings sound (`readingDistance`); null when unavailable. */
  readonly distance: number | null;
  /** The linker's result on the unbiased reading; null when unavailable. */
  readonly unbiased: LinkResult | null;
  /** `witness_conflict` on the field, for a conflict; empty otherwise. */
  readonly flags: readonly WitnessFlag[];
  /** For a conflict on a target decided "linked" or "new": the target as a question. */
  readonly downgrade: TargetDowngrade | null;
}

/**
 * How differently two readings of a name sound, in [0, 1]: 1 minus the similarity of their codes
 * run together (`codeSimilarity`, what the linker's `phonFull` reads), with each homophone as its
 * set's first spelling and split or joined words alike ("Sean Murfy" and "Shawn Murphy" are 0
 * apart, "Atmos Industrial" and "Atmos Industries" 1/11). Names with no codes (digits) are 0 apart
 * when their matching forms are equal and 1 apart otherwise.
 */
export function readingDistance(a: string, b: string): number {
  const left = phrase(a);
  const right = phrase(b);
  if (left.text === right.text) return 0;
  if (left.codes.length === 0 || right.codes.length === 0) return 1;
  return 1 - codeSimilarity(left.codes, right.codes);
}

function outcomeOf(result: LinkResult): ReadingOutcome {
  return { decision: result.decision, entityId: result.entityId };
}

/** A reading's own answer: the record it linked, "new", or an ask's first candidate. */
function choiceOf(result: LinkResult): TargetCandidate | null {
  if (result.decision === "linked") return { entityId: result.entityId, p: result.p ?? 0 };
  if (result.decision === "new") return { entityId: null, p: result.p ?? 0 };
  return result.candidates[0] ?? null;
}

function byLikelihood(a: TargetCandidate, b: TargetCandidate): number {
  return b.p - a.p || (a.entityId === null ? 1 : 0) - (b.entityId === null ? 1 : 0);
}

/**
 * A downgrade's candidates: the old target (the biased reading's record, or "new") first, then
 * the unbiased reading's choice, then every other candidate of either reading by p, without
 * repeats, at most 3 records plus "new". A record both readings list keeps its first p.
 */
export function mergeCandidates(biased: LinkResult, unbiased: LinkResult): TargetCandidate[] {
  const out: TargetCandidate[] = [];
  let records = 0;
  const add = (candidate: TargetCandidate | null | undefined) => {
    if (!candidate || out.some((kept) => kept.entityId === candidate.entityId)) return;
    if (candidate.entityId !== null) {
      if (records >= MAX_DOWNGRADE_RECORDS) return;
      records++;
    }
    out.push(candidate);
  };
  add(choiceOf(biased));
  add(choiceOf(unbiased));
  for (const candidate of [...biased.candidates, ...unbiased.candidates].sort(byLikelihood)) {
    add(candidate);
  }
  return out;
}

/**
 * Compares the witnesses at one mention (spec §4.6): links the unbiased reading with the same
 * index and context (`ctx`, the biased link's), measures how differently the two sound, and
 * applies the rule with the parameters' θ_d.
 */
export function compareWitnesses(input: WitnessInput, ctx: LinkContext): WitnessComparison {
  const field = input.field ?? TARGET_FIELD;
  const reading = input.unbiased;
  if (reading === null || phrase(reading.text).tokens.length === 0) {
    return {
      field,
      outcome: "unavailable",
      distance: null,
      unbiased: null,
      flags: [],
      downgrade: null,
    };
  }
  const unbiased = link(
    {
      text: reading.text,
      kind: input.mention.kind,
      companyText: reading.companyText ?? input.mention.companyText ?? null,
    },
    ctx,
  );
  const distance = readingDistance(input.mention.text, reading.text);
  const conflict = witnessConflict(
    outcomeOf(input.biased),
    outcomeOf(unbiased),
    distance,
    ctx.params.thresholds.thetaD,
  );
  if (!conflict) return { field, outcome: "agree", distance, unbiased, flags: [], downgrade: null };
  const downgrade: TargetDowngrade | null =
    field === TARGET_FIELD && isDecision(input.biased.decision)
      ? { decision: "ask", candidates: mergeCandidates(input.biased, unbiased) }
      : null;
  return {
    field,
    outcome: "conflict",
    distance,
    unbiased,
    flags: [{ kind: "witness_conflict", field }],
    downgrade,
  };
}
