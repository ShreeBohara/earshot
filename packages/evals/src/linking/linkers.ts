// How the harness runs a linker over the set. A linker sees a `LinkingCase`, the item with every
// label stripped (gold, class, expect, cue, group, what was said, and the simulator's notes), and
// returns two decisions per item: with the second witness off ("biased only") and after it.
//
// Linker v0 is Phase 3's exact matcher, `matchEntity` from @earshot/agent, applied the way
// `attachEvidence` applies it: to the words the biased transcript has for the mention, among the
// kinds the proposal type allows. A match links; no match is a new contact for a contact
// proposal (Phase 3's `new_entity`) and no target otherwise. It has no probability and no witness.
// WP4 adds linker v1 here.
//
// The oracle is a reference: the set's ground truth run as a two-witness linker, the ceiling the
// set allows under the simulator's rules.
import { matchEntity, TARGET_KINDS } from "@earshot/agent";
import type { EntityKind, EntityRef, ProposalType, TargetDecision } from "@earshot/core";
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
  /** The calibrated probability of the link; null when the linker has none. */
  readonly p: number | null;
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

export const LINKERS: Readonly<Record<string, Linker>> = { v0: LINKER_V0, oracle: LINKER_ORACLE };
