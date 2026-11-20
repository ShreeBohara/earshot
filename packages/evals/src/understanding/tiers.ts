// The likely-edit tiers' metrics (Phase 5 spec §4.4, WP4; ADR-0031 as amended, ADR-0035): how
// many final proposals each tier marks, whether the marks fall where the ground truth says a
// reviewer has something to change, and whether the seeded errors are marked at all. Pure, like
// the rest of the report: `understandingMetrics` collects each final proposal with the expected
// one it matched, and each seeded error's proposal, and this scores them with `tierOf`.
//
// | Metric | Definition | Budget |
// |---|---|---|
// | Loud share | Final proposals with a loud reason ÷ final proposals | ≤ 15% (target); gated at the interim ceiling, 18% |
// | Marked share | Final proposals with a loud reason or a quiet note on the card ÷ final proposals | ≤ 35%, gated |
// | Name-note share | Final proposals whose only marker is the name note ÷ final proposals | Reported |
// | Loud floor | Final proposals with an ask, a witness conflict, or an unsupported value ÷ final proposals: what stays loud whatever the display rules | Reported; sets the interim ceiling |
// | Surfacing recall | Seeded errors whose proposal carries any marker, the name note included ÷ seeded errors | ≥ 95%, gated |
// | Precision, per tier | Proposals in the tier the ground truth says need a choice, an edit, or a rejection ÷ proposals in the tier | Reported; aim ≥ 50% on loud |
// | Hidden wrong accounts | Matched proposals linked to a record the ground truth doesn't name, with no marker at all | Reported |
import {
  type LoudReasonKind,
  type QuietReasonKind,
  type Tier,
  tierOf,
} from "@earshot/understanding/tiers";
import type { ExpectedProposal } from "../schema";
import type { Ratio } from "./metrics";
import type { FinalProposal } from "./run";

/** The spec's loud budget (decision 8, §4.4): a target, which the gate can't hold yet. */
export const LOUD_SHARE_TARGET = 0.15;

/**
 * The interim ceiling the gate holds the loud share to, in place of `LOUD_SHARE_TARGET`.
 *
 * WP4 measured the loud floor on the 200 debriefs before changing anything: asks, witness
 * conflicts, and unsupported values alone are 118 of 751 final proposals, 15.71% (32 asks, 68
 * conflicts, and 20 unsupported targets, 2 proposals both an ask and a conflict), the same on both
 * adapters. Display rules can't bring that under 15%, so the ceiling is the floor plus 2 points,
 * rounded up to a whole percent: 18%. The real fix is fewer false witness conflicts (22 of the 68
 * aren't conflicts the scripts expect, and 19 of those turned right links into asks): a linker or
 * witness change once Phase 4's mined set has run, not a change to the tiers. Lower this to
 * `LOUD_SHARE_TARGET` when the floor allows it; a test in understanding.test.ts fails when the
 * floor moves.
 */
export const LOUD_SHARE_INTERIM_CEILING = 0.18;

/** The spec's budget for any marker on the card, loud or quiet (the name note doesn't count). */
export const MARKED_SHARE_BUDGET = 0.35;

/** The least share of seeded errors that must carry a marker, the name note included. */
export const SURFACING_RECALL_BUDGET = 0.95;

/** The loud reasons that make the floor: what no display rule can quiet. */
export const LOUD_FLOOR_KINDS: readonly LoudReasonKind[] = [
  "ask",
  "witness_conflict",
  "unsupported",
];

/** One final proposal, with the expected proposal it matched (none for an extra). */
export interface TierItem {
  readonly proposal: FinalProposal;
  readonly expected: ExpectedProposal | undefined;
}

export interface TierMetrics {
  readonly proposals: number;
  /** `loudShare`. */
  readonly loud: Ratio;
  /** `markedShare`: a loud reason or a quiet note on the card. */
  readonly marked: Ratio;
  /** `nameNoteShare`: the name note and nothing else. */
  readonly nameNoteOnly: Ratio;
  /** Asks, witness conflicts, and unsupported values: the floor under the loud share. */
  readonly loudFloor: Ratio;
  /**
   * For each loud reason: `of`, the proposals carrying it, and `n`, those the ground truth says
   * need a change, so `rate` is the reason's precision and `of ÷ proposals` its share.
   */
  readonly loudKinds: Readonly<Partial<Record<LoudReasonKind, Ratio>>>;
  /** For each quiet reason, the proposals carrying it. */
  readonly quietKinds: Readonly<Partial<Record<QuietReasonKind, number>>>;
  /** `surfacingRecall`: seeded errors whose proposal carries any marker. */
  readonly surfacing: Ratio;
  /** `needsChangePrecision`, per tier: loud, quiet with a card note, quiet by the name alone. */
  readonly precision: {
    readonly loud: Ratio;
    readonly quiet: Ratio;
    readonly nameNote: Ratio;
  };
  /** Wrong accounts no marker points at: the errors reviewers would learn to miss. */
  readonly hiddenWrongAccounts: number;
}

function ratio(n: number, of: number): Ratio {
  return { n, of, rate: of === 0 ? null : n / of };
}

/** The record a target gives a reviewer who accepts it as it stands; `undefined` for none. */
function recordOf(target: FinalProposal["target"]): string | null | undefined {
  if (target.decision === "linked") return target.entityId;
  if (target.decision === "new") return null;
  return undefined;
}

/**
 * Whether the ground truth says a reviewer must do more than accept the proposal as it stands:
 *
 * - **a rejection:** it matched no expected proposal (an extra);
 * - **a choice:** the ground truth itself calls for one (an expected "ask", such as a snapped new
 *   name), or the record is wrong: a link or a new record the ground truth doesn't name, no record
 *   where one was meant, or a question that doesn't offer the record meant;
 * - **an edit:** a value the ground truth states differently, or a field missing.
 *
 * A question that offers the record meant, where the ground truth names that record outright, is
 * a false alarm, not a needed choice: the reviewer only has to undo the doubt (the 19 false
 * conflicts are these). Quiet notes on right values, such as a date the normalizers already fixed,
 * count against their tier's precision the same way.
 */
export function needsChange(
  expected: ExpectedProposal | undefined,
  actual: FinalProposal,
): boolean {
  if (expected === undefined) return true;
  const truth = expected.target;
  if (truth.decision === "ask") return true;
  const { target } = actual;
  if (target.decision === "ask") {
    if (truth.decision === "none") return true;
    if (!target.candidates.some((candidate) => candidate.entityId === truth.id)) return true;
  } else if (target.decision === "none") {
    if (truth.decision !== "none") return true;
  } else {
    const meant = truth.decision === "none" ? undefined : truth.id;
    if (truth.decision === "linked" && target.decision !== "linked") return true;
    if (truth.decision === "new" && target.decision !== "new") return true;
    if (recordOf(target) !== meant) return true;
  }
  const fields = expected.fields as Readonly<
    Record<string, { value: string | number } | undefined>
  >;
  for (const [name, field] of Object.entries(fields)) {
    if (field !== undefined && actual.fields[name]?.value !== field.value) return true;
  }
  return false;
}

/** Whether a tier marks a proposal at all: a loud reason, a quiet note, or the name note. */
function anyMarker(tier: Tier): boolean {
  return tier.tier !== "none";
}

/**
 * The tier metrics over every final proposal (`items`) and each seeded error's proposal
 * (`seeded`, undefined where the error's proposal went missing, which counts as unmarked).
 */
export function tierMetrics(
  items: readonly TierItem[],
  seeded: readonly (FinalProposal | undefined)[],
): TierMetrics {
  let loud = 0;
  let marked = 0;
  let nameNoteOnly = 0;
  let floor = 0;
  let loudNeeds = 0;
  let quiet = 0;
  let quietNeeds = 0;
  let nameNeeds = 0;
  let hidden = 0;
  const loudKinds: Partial<Record<LoudReasonKind, { n: number; of: number }>> = {};
  const quietKinds: Partial<Record<QuietReasonKind, number>> = {};
  for (const { proposal, expected } of items) {
    const tier = tierOf(proposal);
    const needs = needsChange(expected, proposal);
    const card = tier.reasons.length > 0;
    if (card) marked++;
    if (tier.tier === "loud") {
      loud++;
      if (needs) loudNeeds++;
    } else if (card) {
      quiet++;
      if (needs) quietNeeds++;
    } else if (tier.nameNote !== null) {
      nameNoteOnly++;
      if (needs) nameNeeds++;
    }
    const loudSeen = new Set<LoudReasonKind>();
    const quietSeen = new Set<QuietReasonKind>();
    for (const reason of tier.reasons) {
      if (reason.tier === "loud") loudSeen.add(reason.kind);
      else quietSeen.add(reason.kind);
    }
    for (const kind of loudSeen) {
      const entry = loudKinds[kind] ?? { n: 0, of: 0 };
      loudKinds[kind] = entry;
      entry.of++;
      if (needs) entry.n++;
    }
    for (const kind of quietSeen) quietKinds[kind] = (quietKinds[kind] ?? 0) + 1;
    if (LOUD_FLOOR_KINDS.some((kind) => loudSeen.has(kind))) floor++;
    const wrongAccount =
      expected !== undefined &&
      proposal.target.decision === "linked" &&
      proposal.target.entityId !== expected.target.id;
    if (wrongAccount && !anyMarker(tier)) hidden++;
  }
  const total = items.length;
  const surfaced = seeded.filter(
    (proposal) => proposal !== undefined && anyMarker(tierOf(proposal)),
  ).length;
  return {
    proposals: total,
    loud: ratio(loud, total),
    marked: ratio(marked, total),
    nameNoteOnly: ratio(nameNoteOnly, total),
    loudFloor: ratio(floor, total),
    loudKinds: Object.fromEntries(
      Object.entries(loudKinds).map(([kind, entry]) => [kind, ratio(entry.n, entry.of)]),
    ),
    quietKinds,
    surfacing: ratio(surfaced, seeded.length),
    precision: {
      loud: ratio(loudNeeds, loud),
      quiet: ratio(quietNeeds, quiet),
      nameNote: ratio(nameNeeds, nameNoteOnly),
    },
    hiddenWrongAccounts: hidden,
  };
}
