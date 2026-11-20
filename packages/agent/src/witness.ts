// The second witness's comparison for one turn (Phase 4 spec §4.6, WP9; ADR-0029). Pure, run in
// SessionDO once a turn's proposals and its unbiased transcript both exist.
//
// For each proposal whose target was named (a contact's by its `name`, so the spec's "each contact
// `name` field" is this same mention), as WP5 laid out:
// 1. `readUnbiased` reads the unbiased witness's words where the target's quote sits in the biased
//    utterance: by word timings when both sides have them, by alignment otherwise. The biased
//    utterance's own timings decide: an audio window interpolated by character position is no
//    window to read by.
// 2. The company said with it is read the same way; without a reading the biased company stands.
// 3. `compareWitnesses` links that reading with the same `LinkContext` the turn's linking used:
//    the session's index and open account, the earlier links this proposal saw, and the turn's
//    other named records (`ProposalLink`, which `runTurn` returns and SessionDO keeps per turn).
// 4. A conflict becomes a `proposal.flagged` payload: the `witness_conflict` flag on the target,
//    a downgrade to "ask" when the target was decided ("linked" or "new"), and the two readings.
//
// An implied target or none named has no words to reread, and an unavailable reading (the witness
// heard nothing there) is never a conflict. Agreement changes nothing.
import {
  type EntityKind,
  type ProposalFlaggedV1,
  TARGET_FIELD,
  type TargetV2,
  type UtteranceFinalV2,
} from "@earshot/core";
import {
  LINKER_PARAMS_V1,
  type LinkerParams,
  type LinkIndex,
  type LinkResult,
  type MentionInput,
} from "@earshot/understanding/link";
import {
  type BiasedQuote,
  compareWitnesses,
  readUnbiased,
  type UnbiasedReading,
} from "@earshot/understanding/witness";
import { linkerMention } from "./understand";

/**
 * What one proposal's target linker read, so the witness can be compared with the same context
 * later (SessionDO keeps it per turn, through hibernation).
 */
export interface ProposalLink {
  readonly proposalId: string;
  /** The target as written: its decision, candidates, and the quotes the witness rereads. */
  readonly target: TargetV2;
  /** The mention as the linker read it; null when nothing was named (implied, none). */
  readonly mention: MentionInput | null;
  /** The record kinds the proposal type allows. */
  readonly kinds: readonly EntityKind[];
  /** The session's earlier links as this proposal saw them, the turn's earlier ones included. */
  readonly recent: readonly string[];
  /** The turn's other named records. */
  readonly turnMentions: readonly MentionInput[];
}

export interface WitnessTurnInput {
  /** The turn's proposals as linked, in order. */
  readonly links: readonly ProposalLink[];
  /** The turn's biased utterances: where the targets' quotes are. */
  readonly utterances: readonly UtteranceFinalV2[];
  /** The second witness's transcript of the turn. */
  readonly unbiased: UtteranceFinalV2;
  /** The session as the linker sees it. */
  readonly session: {
    readonly index: LinkIndex;
    readonly focusEntityId: string | null;
    readonly params?: LinkerParams;
  };
}

export interface WitnessTurnResult {
  /** `proposal.flagged` payloads, one per conflict, in the proposals' order. */
  readonly flagged: readonly ProposalFlaggedV1[];
  /** Targets compared: those with words to reread and a reading of them. */
  readonly compared: number;
  /** Targets whose reading was unavailable: no unbiased words where the quote is. */
  readonly unavailable: number;
}

/** The target as the linker decided it, for `compareWitnesses`. */
function linkResultOf(target: TargetV2): LinkResult {
  return {
    decision: target.decision,
    entityId: target.entityId,
    p: target.p,
    basis: target.basis,
    candidates: target.candidates.map((candidate) => ({ ...candidate })),
  };
}

/** A quote's place in its biased utterance, with an audio window only if the words were timed. */
function quoteIn(
  utterances: ReadonlyMap<string, UtteranceFinalV2>,
  evidence: {
    readonly utteranceId: string;
    readonly span: readonly [number, number];
    readonly audioMs: readonly [number, number];
  },
): BiasedQuote | null {
  const utterance = utterances.get(evidence.utteranceId);
  if (!utterance) return null;
  const timed = (utterance.words?.length ?? 0) > 0;
  return { text: utterance.text, span: evidence.span, audioMs: timed ? evidence.audioMs : null };
}

/** Compares one turn's two witnesses (spec §4.6): the flags and downgrades to append. */
export function witnessTurn(input: WitnessTurnInput): WitnessTurnResult {
  const { session, unbiased } = input;
  const params = session.params ?? LINKER_PARAMS_V1;
  const utterances = new Map(
    input.utterances
      .filter((utterance) => utterance.witness !== "unbiased")
      .map((utterance) => [utterance.utteranceId, utterance]),
  );
  const flagged: ProposalFlaggedV1[] = [];
  let compared = 0;
  let unavailable = 0;
  for (const link of input.links) {
    const { target, mention } = link;
    if (mention === null || target.mention === null) continue;
    const quote = quoteIn(utterances, target.mention.evidence);
    if (quote === null) continue;
    const reading: UnbiasedReading | null = readUnbiased(quote, unbiased);
    if (reading === null) {
      unavailable += 1;
      continue;
    }
    const companyQuote = target.company ? quoteIn(utterances, target.company.evidence) : null;
    const companyReading = companyQuote ? readUnbiased(companyQuote, unbiased) : null;
    // Read as the linker read the biased words: a deal's company folded into its words.
    const heard = linkerMention(
      reading.text,
      mention.kind,
      companyReading?.text ?? target.company?.quote ?? null,
    );
    const comparison = compareWitnesses(
      {
        field: TARGET_FIELD,
        mention,
        biased: linkResultOf(target),
        unbiased: { text: heard.text, companyText: heard.companyText ?? null },
      },
      {
        index: session.index,
        focusEntityId: session.focusEntityId,
        recent: link.recent,
        turnMentions: link.turnMentions,
        params,
        kinds: link.kinds,
      },
    );
    if (comparison.outcome === "unavailable") {
      unavailable += 1;
      continue;
    }
    compared += 1;
    if (comparison.outcome !== "conflict") continue;
    flagged.push({
      proposalId: link.proposalId,
      source: "witness",
      flags: comparison.flags.map((flag) => ({ kind: flag.kind, field: flag.field })),
      target: comparison.downgrade
        ? {
            decision: "ask",
            candidates: comparison.downgrade.candidates.map((candidate) => ({
              entityId: candidate.entityId,
              p: candidate.p,
            })),
          }
        : null,
      conflict: {
        field: comparison.field,
        biased: { text: target.mention.quote, evidence: target.mention.evidence },
        unbiased: {
          text: reading.text,
          utteranceId: reading.utteranceId,
          audioMs: [reading.audioMs[0], reading.audioMs[1]],
        },
      },
    });
  }
  return { flagged, compared, unavailable };
}
