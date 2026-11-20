import type {
  FieldEdit,
  ProposalFieldV2,
  ProposalTypeV2,
  ReopenReason,
  ReviewDecisionV2,
  Reviewer,
  ReviewInputKind,
  ReviewMode,
  ReviewPolicy,
  ReviewSeen,
  ReviewSurface,
  ReviewTarget,
  ReviewTiming,
  RiskFlagV2,
  TargetCandidate,
  TargetV2,
  WitnessConflict,
} from "@earshot/core";
import { ProjectionError } from "../errors";
import type { ProposalFlaggedEvent, ProposalReviewedEvent, SessionEvent } from "../types";
import type { Projection } from "./projection";

/**
 * `proposed` until a reviewer decides; then the decision. A reopen (an undo, or a later flag on
 * an approval) returns it to `proposed`, and a correction that replaces it makes it `superseded`.
 */
export type ProposalStatus = "proposed" | "approved" | "edited" | "rejected" | "superseded";

/**
 * The latest review of a proposal, a reopen included: every field of `proposal.reviewed` v2, and
 * where the event is in the log. A review upcast from v1 has null wherever v1 recorded nothing.
 */
export interface ReviewView {
  reviewId: string;
  decision: ReviewDecisionV2;
  /** The record the reviewer chose; a `null` id is a new record. */
  target: ReviewTarget | null;
  editDiff: Record<string, FieldEdit> | null;
  mode: ReviewMode;
  batchId: string | null;
  policy: ReviewPolicy | null;
  /** The review a reopen reversed. */
  undoes: string | null;
  reason: ReopenReason | null;
  seen: ReviewSeen | null;
  timing: ReviewTiming;
  input: ReviewInputKind | null;
  surface: ReviewSurface | null;
  syncEligibleAt: string | null;
  by: Reviewer | null;
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
  /** The proposal this one replaces (a correction or a follow-up's answer); null otherwise. */
  supersedes: string | null;
  /** The proposal that replaced this one; set exactly when the status is `superseded`. */
  supersededBy: string | null;
  /**
   * Hidden from the inbox until this time, from the latest `proposal.snoozed`; null when it was
   * never snoozed or was woken. A review leaves it as it is: the status says whether it's open.
   */
  snoozedUntil: string | null;
  /** Seq and timestamp of the `proposal.created` event. */
  seq: number;
  ts: string;
  review: ReviewView | null;
}

/**
 * Folds `proposal.created`, `proposal.flagged`, `proposal.reviewed`, and `proposal.snoozed` into
 * the session's proposals, in the order they were created.
 *
 * - A review sets the status to its decision, and a reopen returns it to `proposed`. The latest
 *   review, a reopen included, is the proposal's `review`. A reopen must name that review, which
 *   must be a decision, not another reopen; a review or a snooze of a superseded proposal is
 *   refused too. Each is a writer's bug (`checkReview` refuses them first), so the fold fails
 *   with a `ProjectionError`. A v1 log that reviewed a proposal twice, with no reopen between,
 *   still loads: the later decision stands.
 * - A snooze sets `snoozedUntil`, and a snooze with no time wakes the proposal.
 * - A proposal that `supersedes` another makes that one `superseded`, pointing back at it. Only
 *   a proposal the log already has, and that nothing has replaced yet, can be superseded.
 * - A flag adds its flags and conflict, and a downgrade turns the target into a question (see
 *   `downgrade`), whether or not the proposal has been reviewed or replaced.
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
        const earlier =
          payload.supersedes === null
            ? state
            : supersede(state, payload.supersedes, payload.proposalId, event);
        return [
          ...earlier,
          {
            proposalId: payload.proposalId,
            type: payload.type,
            targetEntityId: payload.target.entityId,
            target: payload.target,
            status: "proposed",
            fields: payload.fields,
            riskFlags: payload.riskFlags,
            conflicts: [],
            supersedes: payload.supersedes,
            supersededBy: null,
            snoozedUntil: null,
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
        refuseIfSuperseded(proposal, event, "review");
        if (payload.decision === "reopened") checkReopen(proposal, payload.undoes, event);
        return state.with(index, {
          ...proposal,
          status: payload.decision === "reopened" ? "proposed" : payload.decision,
          review: reviewView(event),
        });
      }
      case "proposal.snoozed": {
        const { payload } = event;
        const [index, proposal] = find(state, payload.proposalId, event, "snooze");
        refuseIfSuperseded(proposal, event, "snooze");
        return state.with(index, { ...proposal, snoozedUntil: payload.until });
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
  verb: "flag" | "review" | "snooze" | "supersede",
): [number, ProposalView] {
  const index = state.findIndex((proposal) => proposal.proposalId === proposalId);
  const proposal = state[index];
  if (!proposal) {
    throw new ProjectionError("proposals", event, `no proposal ${proposalId} to ${verb}`);
  }
  return [index, proposal];
}

/** Marks `earlierId` superseded by `laterId`, or refuses if it's unknown or already replaced. */
function supersede(
  state: readonly ProposalView[],
  earlierId: string,
  laterId: string,
  event: SessionEvent,
): readonly ProposalView[] {
  const [index, earlier] = find(state, earlierId, event, "supersede");
  if (earlier.supersededBy !== null) {
    throw new ProjectionError(
      "proposals",
      event,
      `proposal ${earlierId} was already superseded by ${earlier.supersededBy}`,
    );
  }
  return state.with(index, { ...earlier, status: "superseded", supersededBy: laterId });
}

function refuseIfSuperseded(
  proposal: ProposalView,
  event: SessionEvent,
  verb: "review" | "snooze",
): void {
  if (proposal.supersededBy === null) return;
  throw new ProjectionError(
    "proposals",
    event,
    `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}, so it takes no ${verb}`,
  );
}

/** A reopen must name the proposal's latest review, and that review must be a decision. */
function checkReopen(proposal: ProposalView, undoes: string | null, event: SessionEvent): void {
  const latest = proposal.review;
  if (latest === null || latest.reviewId !== undoes) {
    const which = latest === null ? "it has no review" : `its latest is ${latest.reviewId}`;
    throw new ProjectionError(
      "proposals",
      event,
      `the reopen of proposal ${proposal.proposalId} names review ${undoes}, but ${which}`,
    );
  }
  if (latest.decision === "reopened") {
    throw new ProjectionError(
      "proposals",
      event,
      `the reopen of proposal ${proposal.proposalId} names review ${undoes}, which is a reopen itself`,
    );
  }
}

/** A review event as the view keeps it: every payload field, its seq, and its time. */
function reviewView(event: ProposalReviewedEvent): ReviewView {
  const { payload } = event;
  return {
    reviewId: payload.reviewId,
    decision: payload.decision,
    target: payload.target,
    editDiff: payload.editDiff ?? null,
    mode: payload.mode,
    batchId: payload.batchId,
    policy: payload.policy,
    undoes: payload.undoes,
    reason: payload.reason,
    seen: payload.seen,
    timing: payload.timing,
    input: payload.input,
    surface: payload.surface,
    syncEligibleAt: payload.syncEligibleAt,
    by: payload.by,
    seq: event.seq,
    ts: event.ts,
  };
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
