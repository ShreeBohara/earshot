// Likely-edit tiers (Phase 5 spec §4.4, decision 8; ADR-0035): what a review card marks, from the
// flags and decisions Phase 4 already writes. No confidence threshold and no model: a mark has to
// be precise to help (Vasconcelos et al.), and a wrong account mustn't go unmarked either.
//
// - **Loud:** the target is an ask (the linker's, or a witness downgrade); any `witness_conflict`;
//   `unsupported` on the target or a field; `ambiguous_value`; a `value_mismatch` nothing fixed
//   (no `norm.llmValue`, a self-correction whose retracted value the model kept included); a
//   `new_entity` with a sound-alike record (a candidate at p ≥ 0.05).
// - **Quiet, a note on the card:** `implied_target`; a `value_mismatch` a unique reading fixed;
//   `negation`; `low_confidence`; `weak_support`; a `new_entity` with no sound-alike; v1's `date`
//   and `number`.
// - **Quiet, a note by the name:** `link_uncertain` on a linked target (ADR-0031's option 2),
//   "matched by sound" or "matched in context" beside the record's name.
// - **None:** no flag, or only `self_correction` (the model took the correction).
//
// SessionDO (policies, and what its own reviews record as seen), the web Worker's review route,
// the inbox and the tray ("accept all", the copy), the pilot builder, and the evals all call
// `tierOf`, so one function decides. A record offered at review time (WP12) makes a card loud too,
// but it isn't a flag: the inbox adds it, and the evals don't count it.
//
// Pure, like the rest of the package: the edge Worker, the web Worker, and the browser import it.
// It imports types alone, so its bundle carries none of the linker or the normalizers.
import type { FieldNorm } from "../faithfulness";
import type { TargetBasis, TargetCandidate, TargetDecision } from "../link";

/**
 * `@earshot/core`'s `RiskKindV2`, restated rather than imported, as the linker's contract types
 * are (see `../link`): a type test in @earshot/evals fails when the two differ, so a new kind
 * can't arrive without a tier.
 */
export type RiskKind =
  | "date"
  | "number"
  | "negation"
  | "low_confidence"
  | "unsupported"
  | "new_entity"
  | "witness_conflict"
  | "link_uncertain"
  | "ambiguous_target"
  | "implied_target"
  | "value_mismatch"
  | "ambiguous_value"
  | "self_correction"
  | "weak_support";

/** `RiskFlagV2`'s shape: a kind, on a field, on the target (`field: "target"`), or on neither. */
export interface TierFlag {
  readonly kind: RiskKind;
  readonly field?: string;
}

/**
 * What `tierOf` reads of a proposal: its flags, its target's decision, basis, and candidates, and
 * each field's `norm`. `ProposalView` (`@earshot/events`) and `ProposalCreatedV2` both fit, so the
 * function reads a proposal as the projection folded it, witness downgrades and later flags
 * included, or as it was written.
 */
export interface TierProposal {
  readonly riskFlags: readonly TierFlag[];
  readonly target: {
    readonly decision: TargetDecision;
    readonly basis: TargetBasis | null;
    readonly candidates: readonly TargetCandidate[];
  };
  readonly fields: Readonly<Record<string, { readonly norm?: FieldNorm | undefined }>>;
}

/** `@earshot/core`'s `LikelyEditTier`: what a review's `seen.tier` records. */
export type LikelyEditTier = "loud" | "quiet" | "none";

/**
 * Why a card is loud, each with a first-person line (`apps/web/lib/inbox/voice.ts`):
 * - `witness_conflict`: the two witnesses heard the target's or a field's words differently;
 * - `ask`: the linker asked which record (a witness downgrade is a `witness_conflict` instead);
 * - `unsupported`: the target's or a field's words aren't in what was said;
 * - `new_sound_alike`: a new record, with a record in the CRM that sounds like it;
 * - `ambiguous_value`: the words have more than one reading;
 * - `value_mismatch`: a value that disagrees with its words, and nothing fixed it.
 */
export type LoudReasonKind =
  | "witness_conflict"
  | "ask"
  | "unsupported"
  | "new_sound_alike"
  | "ambiguous_value"
  | "value_mismatch";

/**
 * Why a card carries a quiet note, a short line with no color:
 * - `implied_target`: no record was named, so the open account was assumed;
 * - `value_corrected`: a unique reading of the words replaced the model's value;
 * - `negation`: the value's words sit in a negation;
 * - `low_confidence`: the speech-to-text provider was unsure of the words;
 * - `weak_support`: free text that shares little with the words it cites;
 * - `new_entity`: a new record, with nothing in the CRM that sounds like it;
 * - `date`, `number`: Phase 3's flags on every date and number, in sessions from before Phase 4.
 */
export type QuietReasonKind =
  | "implied_target"
  | "value_corrected"
  | "negation"
  | "low_confidence"
  | "weak_support"
  | "new_entity"
  | "date"
  | "number";

/** A loud reason, and where it is: `target`, a field's name, or null for the whole proposal. */
export interface LoudReason {
  readonly tier: "loud";
  readonly kind: LoudReasonKind;
  readonly field: string | null;
}

/** A quiet reason on the card, and where it is. */
export interface QuietReason {
  readonly tier: "quiet";
  readonly kind: QuietReasonKind;
  readonly field: string | null;
}

export type TierReason = LoudReason | QuietReason;

/** How an uncertain link was made, for the note beside the record's name. */
export type NameNote = "sound" | "context";

export interface Tier {
  /** Loud with any loud reason; quiet with a quiet reason or a name note; none otherwise. */
  readonly tier: LikelyEditTier;
  /**
   * Loud reasons first, then quiet ones, each in `LOUD_ORDER` or `QUIET_ORDER` and then in the
   * order of the proposal's flags. The first loud reason picks the card's first-person line.
   */
  readonly reasons: readonly TierReason[];
  /**
   * "matched by sound" or "matched in context", beside the record's name, for a `link_uncertain`
   * link; null otherwise. It makes the tier quiet, so "accept all" and policies leave the card,
   * but the evals count it apart from the card notes (`nameNoteShare`, not `markedShare`).
   */
  readonly nameNote: NameNote | null;
}

/** The target's field name in flags: `@earshot/core`'s `TARGET_FIELD`. */
export const TARGET_FIELD = "target";

/**
 * A new record is loud when the CRM holds a record at least this likely (spec §4.4): the tray's
 * `ASK_MIN_P`, the lowest probability a question names. Spec WP4 step 2 raises it to 0.20 only if
 * the loud share is over 15% while asks, conflicts, and unsupported values alone are under it.
 * WP4 measured those alone at 15.7% of the 200 debriefs' proposals, so the bar stays here and the
 * gate holds an interim ceiling instead (`@earshot/evals`, ADR-0035). At 0.20 one proposal of 751
 * would turn quiet.
 */
export const SOUND_ALIKE_MIN_P = 0.05;

/** The order loud reasons come in: what the reviewer most needs to settle first. */
export const LOUD_ORDER: readonly LoudReasonKind[] = [
  "witness_conflict",
  "ask",
  "unsupported",
  "new_sound_alike",
  "ambiguous_value",
  "value_mismatch",
];

/** The order quiet reasons come in. */
export const QUIET_ORDER: readonly QuietReasonKind[] = [
  "implied_target",
  "new_entity",
  "value_corrected",
  "negation",
  "low_confidence",
  "weak_support",
  "date",
  "number",
];

/** Whether the CRM holds a record that sounds like a new one: a candidate at p ≥ `minP`. */
function hasSoundAlike(candidates: readonly TargetCandidate[], minP: number): boolean {
  return candidates.some((candidate) => candidate.entityId !== null && candidate.p >= minP);
}

/** What `tierWith` can vary, for the evals' what-ifs; `tierOf` uses `TIER_PARAMS`. */
export interface TierParams {
  /** A new record with a candidate at least this likely is loud. */
  readonly soundAlikeMinP: number;
}

export const TIER_PARAMS: TierParams = Object.freeze({ soundAlikeMinP: SOUND_ALIKE_MIN_P });

/**
 * A proposal's likely-edit tier, with its reasons and any name note (spec §4.4). Pure and total:
 * every flag kind has a role, and a target that's an ask is loud even without its flag.
 */
export function tierOf(proposal: TierProposal): Tier {
  return tierWith(proposal, TIER_PARAMS);
}

/** `tierOf` with other parameters: for measuring a rule before adopting it, never in the product. */
export function tierWith(proposal: TierProposal, params: TierParams): Tier {
  const { riskFlags, target, fields } = proposal;
  const loud: LoudReason[] = [];
  const quiet: QuietReason[] = [];
  const seen = new Set<string>();
  const fresh = (tier: LikelyEditTier, kind: string, field: string | null) => {
    const key = `${tier}:${kind}:${field ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const loudOn = (kind: LoudReasonKind, field: string | null) => {
    if (fresh("loud", kind, field)) loud.push({ tier: "loud", kind, field });
  };
  const quietOn = (kind: QuietReasonKind, field: string | null) => {
    if (fresh("quiet", kind, field)) quiet.push({ tier: "quiet", kind, field });
  };

  let uncertainLink = false;
  let targetConflict = false;
  for (const flag of riskFlags) {
    const field = flag.field ?? null;
    switch (flag.kind) {
      case "witness_conflict":
        if (field === TARGET_FIELD) targetConflict = true;
        loudOn("witness_conflict", field);
        break;
      case "ambiguous_target":
        loudOn("ask", TARGET_FIELD);
        break;
      case "unsupported":
        loudOn("unsupported", field);
        break;
      case "ambiguous_value":
        loudOn("ambiguous_value", field);
        break;
      case "value_mismatch": {
        // Fixed when a unique reading replaced the model's value, which `norm.llmValue` keeps.
        // Anything else stands as the model wrote it: a self-correction it got wrong, a name or
        // an email spelled otherwise, an amount in another currency, a value among no readings.
        const fixed = field !== null && fields[field]?.norm?.llmValue !== undefined;
        if (fixed) quietOn("value_corrected", field);
        else loudOn("value_mismatch", field);
        break;
      }
      case "new_entity":
        if (hasSoundAlike(target.candidates, params.soundAlikeMinP)) {
          loudOn("new_sound_alike", field ?? TARGET_FIELD);
        } else {
          quietOn("new_entity", field ?? TARGET_FIELD);
        }
        break;
      case "link_uncertain":
        uncertainLink = true;
        break;
      case "implied_target":
      case "negation":
      case "low_confidence":
      case "weak_support":
      case "date":
      case "number":
        quietOn(flag.kind, field);
        break;
      case "self_correction":
        // Alone, the model took the correction: nothing to mark. With a `value_mismatch` on the
        // same field it kept the retracted value, and that flag is the loud one.
        break;
      default: {
        // A kind added to the contract fails to compile here until it has a tier.
        const unknown: never = flag.kind;
        throw new Error(`no tier for risk kind ${String(unknown)}`);
      }
    }
  }
  // A question with no flag saying so: a downgrade carries its conflict, and the linker's ask its
  // `ambiguous_target`, but a target that can't be accepted as it stands is loud regardless.
  if (target.decision === "ask" && !targetConflict) loudOn("ask", TARGET_FIELD);

  const byOrder = <K extends string>(order: readonly K[]) => {
    const rank = (kind: K) => order.indexOf(kind);
    return (a: { readonly kind: K }, b: { readonly kind: K }) => rank(a.kind) - rank(b.kind);
  };
  // Array.prototype.sort is stable, so reasons of one kind keep the flags' order.
  const reasons: TierReason[] = [
    ...loud.sort(byOrder(LOUD_ORDER)),
    ...quiet.sort(byOrder(QUIET_ORDER)),
  ];
  // The note belongs beside a record's name, so only a target still linked carries it: a
  // downgraded one is a question, and loud already.
  const nameNote: NameNote | null =
    uncertainLink && target.decision === "linked"
      ? target.basis === "context"
        ? "context"
        : "sound"
      : null;
  const tier: LikelyEditTier =
    loud.length > 0 ? "loud" : quiet.length > 0 || nameNote !== null ? "quiet" : "none";
  return { tier, reasons, nameNote };
}
