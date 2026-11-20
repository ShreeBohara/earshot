import type {
  FieldEdit,
  ProposalFieldV2,
  ProposalTypeV2,
  ReviewDecision,
  RiskFlagV2,
  TargetCandidate,
  TargetV2,
  WitnessConflict,
} from "@earshot/core";
import { ProjectionError } from "../errors";
import type { ProposalFlaggedEvent, SessionEvent } from "../types";
import type { Projection } from "./projection";

/** `proposed` until a reviewer decides; then the decision. */
export type ProposalStatus = "proposed" | ReviewDecision;

/** The latest review of a proposal. */
export interface ReviewView {
  decision: ReviewDecision;
  editDiff: Record<string, FieldEdit> | null;
  reviewerMs: number;
  /** Seq and timestamp of the `proposal.reviewed` event. */
  seq: number;
  ts: string;
}

/** One proposal with its evidence and review status: the `proposals` row. */
export interface ProposalView {
  proposalId: string;
  type: ProposalTypeV2;
  /**
   * The record the proposal changes: `target.entityId`, set when the linker linked one, else
   * null. The `target_entity_id` column; `target` holds the whole decision.
   */
  targetEntityId: string | null;
  /** The linker's decision, after any downgrade by the second witness. */
  target: TargetV2;
  status: ProposalStatus;
  /** Proposed values, each with the evidence it came from. Edits live in `review.editDiff`. */
  fields: Record<string, ProposalFieldV2>;
  /** The proposal's own flags, then each one `proposal.flagged` added that it didn't have. */
  riskFlags: RiskFlagV2[];
  /** Where the two witnesses disagreed, in the order `proposal.flagged` reported it. */
  conflicts: WitnessConflict[];
  /** Seq and timestamp of the `proposal.created` event. */
  seq: number;
  ts: string;
  review: ReviewView | null;
}

/**
 * Folds `proposal.created`, `proposal.flagged`, and `proposal.reviewed` into the session's
 * proposals, in the order they were created. A later review replaces an earlier one, so undoing
 * a decision and deciding again leaves the latest decision. A flag adds its flags and conflict,
 * and a downgrade turns the target into a question (see `downgrade`), whether or not the
 * proposal has been reviewed.
 */
export const proposalsProjection: Projection<readonly ProposalView[]> = {
  initial: [],
  apply(state, event) {
    switch (event.type) {
      case "proposal.created": {
        const { payload } = event;
        if (state.some((proposal) => proposal.proposalId === payload.proposalId)) {
          throw new ProjectionError(
            "proposals",
            event,
            `proposal ${payload.proposalId} already exists`,
          );
        }
        return [
          ...state,
          {
            proposalId: payload.proposalId,
            type: payload.type,
            targetEntityId: payload.target.entityId,
            target: payload.target,
            status: "proposed",
            fields: payload.fields,
            riskFlags: payload.riskFlags,
            conflicts: [],
            seq: event.seq,
            ts: event.ts,
            review: null,
          },
        ];
      }
      case "proposal.flagged": {
        const { payload } = event;
        const [index, proposal] = find(state, payload.proposalId, event, "flag");
        const target = payload.target
          ? downgrade(proposal.target, payload.target.candidates, event)
          : proposal.target;
        return state.with(index, {
          ...proposal,
          targetEntityId: target.entityId,
          target,
          riskFlags: withFlags(proposal.riskFlags, payload.flags),
          conflicts: payload.conflict
            ? [...proposal.conflicts, payload.conflict]
            : proposal.conflicts,
        });
      }
      case "proposal.reviewed": {
        const { payload } = event;
        const [index, proposal] = find(state, payload.proposalId, event, "review");
        return state.with(index, {
          ...proposal,
          status: payload.decision,
          review: {
            decision: payload.decision,
            editDiff: payload.editDiff ?? null,
            reviewerMs: payload.reviewerMs,
            seq: event.seq,
            ts: event.ts,
          },
        });
      }
      default:
        return state;
    }
  },
};

/** The proposal an event points at, with its index, or a `ProjectionError` if it has none. */
function find(
  state: readonly ProposalView[],
  proposalId: string,
  event: SessionEvent,
  verb: "flag" | "review",
): [number, ProposalView] {
  const index = state.findIndex((proposal) => proposal.proposalId === proposalId);
  const proposal = state[index];
  if (!proposal) {
    throw new ProjectionError("proposals", event, `no proposal ${proposalId} to ${verb}`);
  }
  return [index, proposal];
}

/**
 * A witness downgrade (Phase 4 spec §4.6). The decision becomes "ask" and `entityId` is cleared.
 * The candidates are the downgrade's, with the record the target named before first: the linked
 * record, or, for "new", the new one (a `null` id). The downgrade must list that record, with the
 * probability the comparison gave it; one that doesn't is a `ProjectionError`, since inventing a
 * probability here would hide a bug in the comparison. A target that was already a question, or
 * named nothing, takes the downgrade's candidates as they are. The rest of the target stays.
 */
function downgrade(
  target: TargetV2,
  candidates: readonly TargetCandidate[],
  event: ProposalFlaggedEvent,
): TargetV2 {
  if (target.decision !== "linked" && target.decision !== "new") {
    return { ...target, decision: "ask", entityId: null, candidates: [...candidates] };
  }
  const previous = candidates.find((candidate) => candidate.entityId === target.entityId);
  if (!previous) {
    const named = target.entityId === null ? "a new record" : `record ${target.entityId}`;
    throw new ProjectionError(
      "proposals",
      event,
      `the downgrade of proposal ${event.payload.proposalId} doesn't list ${named}, its target`,
    );
  }
  return {
    ...target,
    decision: "ask",
    entityId: null,
    candidates: [previous, ...candidates.filter((candidate) => candidate !== previous)],
  };
}

/** `flags`, then each of `added` that isn't already there: the same kind on the same field. */
function withFlags(flags: readonly RiskFlagV2[], added: readonly RiskFlagV2[]): RiskFlagV2[] {
  const key = (flag: RiskFlagV2) => `${flag.kind}:${flag.field ?? ""}`;
  const seen = new Set(flags.map(key));
  const result = [...flags];
  for (const flag of added) {
    if (seen.has(key(flag))) continue;
    seen.add(key(flag));
    result.push(flag);
  }
  return result;
}
