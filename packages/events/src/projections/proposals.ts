import type {
  FieldEdit,
  ProposalField,
  ProposalType,
  ReviewDecision,
  RiskFlag,
} from "@earshot/core";
import { ProjectionError } from "../errors";
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
  type: ProposalType;
  targetEntityId: string | null;
  status: ProposalStatus;
  /** Proposed values, each with the evidence it came from. Edits live in `review.editDiff`. */
  fields: Record<string, ProposalField>;
  riskFlags: RiskFlag[];
  /** Seq and timestamp of the `proposal.created` event. */
  seq: number;
  ts: string;
  review: ReviewView | null;
}

/**
 * Folds `proposal.created` and `proposal.reviewed` into the session's proposals, in the order they
 * were created. A later review replaces an earlier one, so undoing a decision and deciding again
 * leaves the latest decision.
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
            targetEntityId: payload.targetEntityId,
            status: "proposed",
            fields: payload.fields,
            riskFlags: payload.riskFlags,
            seq: event.seq,
            ts: event.ts,
            review: null,
          },
        ];
      }
      case "proposal.reviewed": {
        const { payload } = event;
        const index = state.findIndex((proposal) => proposal.proposalId === payload.proposalId);
        const proposal = state[index];
        if (!proposal) {
          throw new ProjectionError(
            "proposals",
            event,
            `no proposal ${payload.proposalId} to review`,
          );
        }
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
