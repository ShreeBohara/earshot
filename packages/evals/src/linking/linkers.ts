// How the harness runs a linker over the set. A linker sees a `LinkingCase`, the item with every
// label stripped (gold, class, expect, cue, group, what was said, and the simulator's notes), and
// returns two decisions per item: with the second witness off ("biased only") and after it.
//
// Linker v0 is Phase 3's exact matcher, `matchEntity` from @earshot/agent, applied the way
// `attachEvidence` applies it: to the words the biased transcript has for the mention, among the
// kinds the proposal type allows. A match links; no match is a new contact for a contact
// proposal (Phase 3's `new_entity`) and no target otherwise. It has no probability and no witness.
//
// Linker v1 (WP4) is `link` from @earshot/understanding/link with its committed parameters, run
// on the biased transcript's mention, the company said with it, the open account, and earlier
// links. Its second witness (WP5) is @earshot/understanding/witness: the unbiased transcript's
// words for the mention and the company, read by alignment (the set has no word timings), linked
// the same way and compared; a conflict downgrades a decided target to "ask".
//
// The oracle is a reference: the set's ground truth run as a two-witness linker, the ceiling the
// set allows under the simulator's rules.
import { matchEntity, TARGET_KINDS } from "@earshot/agent";
import type { EntityKind, EntityRef, ProposalType, TargetDecision } from "@earshot/core";
import {
  buildLinkIndex,
  LINKER_PARAMS_V1,
  type LinkerParams,
  type LinkResult,
  link,
  type MentionInput,
} from "@earshot/understanding/link";
import {
  compareWitnesses,
  readUnbiased,
  type TargetDowngrade,
  type UnbiasedMention,
  type WitnessComparison,
} from "@earshot/understanding/witness";
import { sameSoundPhrase } from "../channel/sound";
import { type Observation, type Resolution, resolve } from "./oracle";
import type { ConfusableItem, Span } from "./schema";

/** One witness's transcript, as a linker may read it. */
export interface CaseReading {
  readonly transcript: string;
  readonly mention: Span;
  readonly company: Span | null;
}

/** What a linker may read about an item. */
export interface LinkingCase {
  readonly id: string;
  readonly type: ProposalType;
  /** The kind the extractor gave the mention. */
  readonly kind: EntityKind;
  readonly biased: CaseReading;
  readonly unbiased: CaseReading;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
}

export function linkingCase(item: ConfusableItem): LinkingCase {
  const strip = (reading: ConfusableItem["biased"]): CaseReading => ({
    transcript: reading.transcript,
    mention: reading.mention,
    company: reading.company,
  });
  return {
    id: item.id,
    type: item.type,
    kind: item.said.kind,
    biased: strip(item.biased),
    unbiased: strip(item.unbiased),
    focusEntityId: item.context.focusEntityId,
    recent: item.context.recent,
  };
}

export interface LinkDecision {
  readonly decision: TargetDecision;
  /** Set exactly when the decision is "linked". */
  readonly entityId: string | null;
  /**
   * The calibrated probability: of the link; for "new", of a new record; for "ask", of its best
   * candidate (WP3's finding: the risk–coverage sweep needs it). Null when the linker has none.
   */
  readonly p: number | null;
  /**
   * For an "ask" that only τ_link held back (its best candidate already leads the next by δ):
   * the record it would link once τ_link fell to `p`. The risk–coverage sweep admits it there.
   * Absent or null otherwise: an ask on a near tie never becomes a link by lowering τ_link.
   */
  readonly wouldLink?: string | null;
}

export interface LinkPrediction {
  readonly id: string;
  /** With the second witness off. */
  readonly biased: LinkDecision;
  /** After the second witness: a downgrade turns "linked" or "new" into "ask". */
  readonly final: LinkDecision;
  /** The witness flagged a conflict on this mention (a downgrade is one). */
  readonly flagged: boolean;
}

export interface Linker {
  /** Its version, as `proposal.created` v2's `linker` field would carry it. */
  readonly name: string;
  /** Whether it runs the second witness. */
  readonly witness: boolean;
  /** Whether G1's thresholds apply to it (spec §6); v0 is a reference, not a candidate. */
  readonly gate: boolean;
  /** Its committed baseline, under packages/evals/baselines; null for a reference without one. */
  readonly baseline: string | null;
  predict(cases: readonly LinkingCase[], entities: readonly EntityRef[]): LinkPrediction[];
}

const NO_TARGET: LinkDecision = { decision: "none", entityId: null, p: null };
const NEW_RECORD: LinkDecision = { decision: "new", entityId: null, p: null };

/** Phase 3's exact matcher, as linker v0. */
export const LINKER_V0: Linker = {
  name: "linker.v0",
  witness: false,
  gate: false,
  baseline: "linking-v0.json",
  predict(cases, entities) {
    return cases.map((linkingCase) => {
      const match = matchEntity(
        linkingCase.biased.mention.text,
        entities,
        TARGET_KINDS[linkingCase.type],
      );
      const decision: LinkDecision = match
        ? { decision: "linked", entityId: match.id, p: null }
        : linkingCase.type === "contact"
          ? NEW_RECORD
          : NO_TARGET;
      return { id: linkingCase.id, biased: decision, final: decision, flagged: false };
    });
  },
};

function observation(linkingCase: LinkingCase, witness: "biased" | "unbiased"): Observation {
  const reading = linkingCase[witness];
  return {
    type: linkingCase.type,
    kind: linkingCase.kind,
    mention: reading.mention.text,
    company: reading.company?.text ?? null,
    focusEntityId: linkingCase.focusEntityId,
    recent: linkingCase.recent,
  };
}

function asDecision(resolution: Resolution): LinkDecision {
  return resolution.decision === "link"
    ? { decision: "linked", entityId: resolution.entityId, p: 1 }
    : { decision: resolution.decision, entityId: null, p: null };
}

/**
 * A reference, not a candidate: the set's own ground truth (oracle.ts) run as a linker on each
 * witness's reading, with the comparison of spec §4.6 at its simplest: a conflict is two readings
 * that sound different and resolve differently (another record, or "new" against "linked"), and
 * it turns a decision into "ask". It knows the simulator's rules and the homophone list, and
 * only the demo CRM, so it shows how far the set lets a linker go, not how far a linker gets.
 */
export const LINKER_ORACLE: Linker = {
  name: "oracle.channel-v1",
  witness: true,
  gate: false,
  baseline: null,
  predict(cases) {
    return cases.map((linkingCase) => {
      const biased = resolve(observation(linkingCase, "biased"));
      const unbiased = resolve(observation(linkingCase, "unbiased"));
      const decision = asDecision(biased);
      const differ =
        (biased.decision === "link" &&
          unbiased.decision === "link" &&
          biased.entityId !== unbiased.entityId) ||
        (biased.decision === "link" && unbiased.decision === "new") ||
        (biased.decision === "new" && unbiased.decision === "link");
      const conflict =
        differ &&
        !sameSoundPhrase(linkingCase.biased.mention.text, linkingCase.unbiased.mention.text);
      // A conflict needs a decided reading on the biased side, so it always downgrades.
      const final: LinkDecision = conflict
        ? { decision: "ask", entityId: null, p: null }
        : decision;
      return { id: linkingCase.id, biased: decision, final, flagged: conflict };
    });
  },
};

/** What `link` is given for one witness's reading of a case. */
export interface LinkerInput {
  readonly mention: MentionInput;
  readonly focusEntityId: string | null;
  readonly recent: readonly string[];
  readonly turnMentions: readonly MentionInput[];
  readonly kinds: readonly EntityKind[];
}

/**
 * A case as `link` reads it: the mention's words, the kind the extractor gave it, and the
 * company said with it, from one witness's transcript; the open account; earlier links; and the
 * kinds the proposal type allows. A confusable-set item names one record, so the turn has no
 * other mentions.
 */
export function linkerInput(
  linkingCase: LinkingCase,
  witness: "biased" | "unbiased" = "biased",
): LinkerInput {
  const reading = linkingCase[witness];
  return {
    mention: {
      text: reading.mention.text,
      kind: linkingCase.kind,
      companyText: reading.company?.text ?? null,
    },
    focusEntityId: linkingCase.focusEntityId,
    recent: linkingCase.recent,
    turnMentions: [],
    kinds: TARGET_KINDS[linkingCase.type],
  };
}

/** What a linker is shown besides the mention's words. An ablation can hide any of it. */
export interface Sees {
  /** The account open in Earshot. */
  readonly focus: boolean;
  /** Records linked earlier in the session. */
  readonly recent: boolean;
  /** The company said with the mention, and the turn's other mentions. */
  readonly company: boolean;
}

export const SEES_ALL: Sees = { focus: true, recent: true, company: true };

/**
 * The input with what `sees` hides cleared. Clearing it from the input, rather than only dropping
 * its features from the model, keeps it out of everything that reads it: the family source, the
 * prefilter's context bonus, and the features derived from it (`rivalContext`).
 */
export function shown(input: LinkerInput, sees: Sees): LinkerInput {
  return {
    mention: sees.company ? input.mention : { ...input.mention, companyText: null },
    focusEntityId: sees.focus ? input.focusEntityId : null,
    recent: sees.recent ? input.recent : [],
    turnMentions: sees.company ? input.turnMentions : [],
    kinds: input.kinds,
  };
}

/** The set's transcripts carry no utterance ids; a reading needs one, so every case uses this. */
const CASE_UTTERANCE_ID = "00000000-0000-7000-8000-000000000000";

/**
 * The unbiased witness's words for a case's mention, and for the company said with it, as
 * `readUnbiased` finds them in the unbiased transcript: by alignment, since the set has no word
 * timings. Null when it has none for the mention.
 */
export function unbiasedMention(linkingCase: LinkingCase): UnbiasedMention | null {
  const { biased, unbiased } = linkingCase;
  const utterance = {
    utteranceId: CASE_UTTERANCE_ID,
    text: unbiased.transcript,
    startMs: 0,
    endMs: 0,
  };
  const read = (span: Span) =>
    readUnbiased({ text: biased.transcript, span: [span.start, span.end] }, utterance);
  const mention = read(biased.mention);
  if (mention === null) return null;
  return {
    text: mention.text,
    companyText: biased.company === null ? null : (read(biased.company)?.text ?? null),
  };
}

/** A downgraded target as the harness scores it: an ask that no lower τ_link would turn into a link. */
export function downgradedDecision(downgrade: TargetDowngrade): LinkDecision {
  const records = downgrade.candidates.filter((candidate) => candidate.entityId !== null);
  return {
    decision: "ask",
    entityId: null,
    p: records.length > 0 ? Math.max(...records.map((candidate) => candidate.p)) : null,
    wouldLink: null,
  };
}

/**
 * The decision after the witness: the downgrade's ask, or the biased decision. An ask the witness
 * flagged keeps no held-back link, since the witness disagrees with it.
 */
export function witnessedDecision(
  biased: LinkDecision,
  comparison: WitnessComparison,
): LinkDecision {
  if (comparison.downgrade) return downgradedDecision(comparison.downgrade);
  if (comparison.outcome === "conflict" && biased.decision === "ask") {
    return { ...biased, wouldLink: null };
  }
  return biased;
}

/** A `link` result as the harness scores it; an ask carries what the risk–coverage sweep needs. */
export function asLinkDecision(result: LinkResult, delta: number): LinkDecision {
  if (result.decision === "linked") {
    return { decision: "linked", entityId: result.entityId, p: result.p };
  }
  if (result.decision === "ask") {
    const [first, second] = result.candidates.filter((candidate) => candidate.entityId !== null);
    const leads = first !== undefined && first.p - (second?.p ?? 0) >= delta;
    return {
      decision: "ask",
      entityId: null,
      p: result.p,
      wouldLink: leads ? (first?.entityId ?? null) : null,
    };
  }
  return { decision: result.decision, entityId: null, p: result.p };
}

/**
 * Linker v1 with a parameter set: the committed one, or an ablation's, with what that ablation
 * hides (`sees`). With the witness (the default), each case's unbiased reading is compared
 * with its biased one (spec §4.6) and a conflict downgrades or flags; without it, the final
 * decisions are the biased-only ones.
 */
export function linkerV1(
  params: LinkerParams = LINKER_PARAMS_V1,
  options: {
    readonly name?: string;
    readonly baseline?: string | null;
    readonly witness?: boolean;
    readonly sees?: Sees;
  } = {},
): Linker {
  const witness = options.witness ?? true;
  const sees = options.sees ?? SEES_ALL;
  return {
    name: options.name ?? params.version,
    witness,
    gate: true,
    baseline: options.baseline === undefined ? "linking.json" : options.baseline,
    predict(cases, entities) {
      const index = buildLinkIndex(entities);
      return cases.map((linkingCase) => {
        const input = shown(linkerInput(linkingCase), sees);
        const ctx = { ...input, index, params };
        const result = link(input.mention, ctx);
        const biased = asLinkDecision(result, params.thresholds.delta);
        if (!witness) return { id: linkingCase.id, biased, final: biased, flagged: false };
        const reading = unbiasedMention(linkingCase);
        const unbiased = reading && !sees.company ? { ...reading, companyText: null } : reading;
        const comparison = compareWitnesses(
          { mention: input.mention, biased: result, unbiased },
          ctx,
        );
        return {
          id: linkingCase.id,
          biased,
          final: witnessedDecision(biased, comparison),
          flagged: comparison.outcome === "conflict",
        };
      });
    },
  };
}

export const LINKER_V1: Linker = linkerV1();

export const LINKERS: Readonly<Record<string, Linker>> = {
  v0: LINKER_V0,
  v1: LINKER_V1,
  oracle: LINKER_ORACLE,
};
