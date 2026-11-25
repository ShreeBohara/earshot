import type {
  CrmProvider,
  FieldEdit,
  FollowupRule,
  ProposalFieldV2,
  ProposalSyncConflictedV1,
  ProposalSyncFailedV1,
  ProposalTypeV2,
  ReopenReasonV3,
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
  SyncedRecord,
  TargetCandidate,
  TargetV2,
  WitnessConflict,
} from "@earshot/core";
import { ProjectionError } from "../errors";
import type {
  FollowupAskedEvent,
  FollowupClosedEvent,
  ProposalFlaggedEvent,
  ProposalReviewedEvent,
  ProposalSyncConflictedEvent,
  ProposalSyncedEvent,
  ProposalSyncFailedEvent,
  ProposalSyncStartedEvent,
  SessionEvent,
} from "../types";
import type { Projection } from "./projection";

/**
 * `proposed` until a reviewer decides; then the decision. A reopen (an undo, a later flag on an
 * approval, or a sync's conflict) returns it to `proposed`, and a correction that replaces it makes
 * it `superseded`. Once its approval syncs to the CRM it's `synced`, and while its latest attempt
 * failed for good it's `failed`, until a Retry's attempt starts and it's the decision again
 * (Phase 6 WP1).
 */
export type ProposalStatus =
  | "proposed"
  | "approved"
  | "edited"
  | "rejected"
  | "superseded"
  | "synced"
  | "failed";

/**
 * The latest review of a proposal, a reopen included: every field of `proposal.reviewed` v3, and
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
  reason: ReopenReasonV3 | null;
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

/** Where a follow-up question stands: waiting, answered by a correction, or skipped. */
export type FollowupStatus = "open" | "answered" | "skipped";

/**
 * A follow-up question about a proposal (Phase 5 WP13): `followup.asked`, and its
 * `followup.closed` once a correction answers it or the rep skips it. An open question moves with
 * its proposal: when a correction replaces the proposal, the question goes to the replacement, so it
 * stays on the card the inbox shows.
 */
export interface FollowupView {
  questionId: string;
  turnId: string;
  /** The proposal it was asked about, which may since have been replaced. */
  askedAbout: string;
  /** The field it asks for, such as `dueDate`. */
  field: string;
  rule: FollowupRule;
  /** The question as the card shows it. */
  text: string;
  status: FollowupStatus;
  /** The proposal whose correction answered it; set exactly when the status is `answered`. */
  answeredBy: string | null;
  /** Seq and timestamp of the `followup.asked` event. */
  seq: number;
  ts: string;
  /** Seq and timestamp of the `followup.closed` event; null while it's open. */
  closedSeq: number | null;
  closedAt: string | null;
}

/** Where a proposal's latest sync attempt stands (Phase 6 spec §4.1). */
export type SyncState = "syncing" | "synced" | "failed" | "conflicted";

/** Why an attempt failed: `proposal.sync_failed` without the fields every sync event names. */
export type SyncFailure = Pick<
  ProposalSyncFailedV1,
  "kind" | "code" | "field" | "landed" | "retryable"
>;

/** Why an attempt stopped to ask: `proposal.sync_conflicted`, the same way. */
export type SyncConflict = Pick<ProposalSyncConflictedV1, "cause" | "fields" | "existing">;

/** What every sync attempt names: its job, the approval it syncs, its number, and the CRM. */
interface SyncAttemptView {
  jobId: string;
  reviewId: string;
  /** From 1; a Retry starts the next under the same idempotency key. */
  attempt: number;
  provider: CrmProvider;
  /** When the attempt's latest event happened: its start, then its result. */
  at: string;
}

/**
 * A proposal's latest sync attempt (Phase 6 spec §4.1, WP1; docs/adr/0040), the `proposals.sync`
 * column: `syncing` from `proposal.sync_started`; then `synced`, with what each write made, changed,
 * or found; `failed`, with why and what landed first; or `conflicted`, with what the CRM holds now.
 * `records` is filled only once it synced, and `error` exactly when it failed or conflicted. A job
 * still waiting for its window, or one canceled at its claim, isn't in the log: it's a `sync_jobs`
 * row.
 */
export type SyncView = SyncAttemptView &
  (
    | { state: "syncing"; records: []; error: null }
    | { state: "synced"; records: SyncedRecord[]; error: null }
    | { state: "failed"; records: []; error: SyncFailure }
    | { state: "conflicted"; records: []; error: SyncConflict }
  );

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
  /**
   * The follow-up questions about it (Phase 5 WP13), in the order they were asked: each asked about
   * it, or still open on a proposal it replaced. A replaced proposal keeps only those closed before
   * it was replaced.
   */
  followups: FollowupView[];
  /** Seq and timestamp of the `proposal.created` event. */
  seq: number;
  ts: string;
  review: ReviewView | null;
  /**
   * Its latest sync attempt (Phase 6 WP1), or null until the outbox claims a job for it. The next
   * attempt, a Retry's or a later approval's, takes its place.
   */
  sync: SyncView | null;
}

/**
 * Folds `proposal.created`, `proposal.flagged`, `proposal.reviewed`, `proposal.snoozed`,
 * `followup.asked`, `followup.closed`, and the sync's events into the session's proposals, in the
 * order they were created.
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
 * - A follow-up question (Phase 5 WP13) is asked about a proposal nothing has replaced, under an id
 *   no other question has, and closes once: answered by the correction that replaced its proposal,
 *   or skipped. When a correction replaces a proposal, its open questions move to the replacement.
 * - A sync attempt (Phase 6 WP1) starts on the proposal it names, whose latest review is the job's,
 *   and is its `sync`; its one result ends it. `proposal.synced` sets the status to `synced` and
 *   `proposal.sync_failed` to `failed`; a later start (a Retry) sets it back to the review's
 *   decision; a conflict changes no status by itself, since the system reopen after it does. A
 *   sync event for a proposal the log doesn't have, a start for a superseded proposal or for a
 *   review that isn't its proposal's latest, approving or editing, a result without a start on its
 *   proposal, two results for one attempt, and a result that names another review or CRM than its
 *   start are writer bugs (`checkSyncEvent` refuses them first), and fail the fold.
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
        // The replaced proposal's open questions move here, so its card keeps asking them.
        const moved =
          payload.supersedes === null
            ? []
            : (state
                .find((proposal) => proposal.proposalId === payload.supersedes)
                ?.followups.filter((followup) => followup.status === "open") ?? []);
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
            followups: moved,
            seq: event.seq,
            ts: event.ts,
            review: null,
            sync: null,
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
      case "followup.asked":
        return asked(state, event);
      case "followup.closed":
        return closed(state, event);
      case "proposal.sync_started":
        return syncStarted(state, event);
      case "proposal.synced":
      case "proposal.sync_failed":
      case "proposal.sync_conflicted":
        return syncEnded(state, event);
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
  verb: "flag" | "review" | "snooze" | "supersede" | "ask about" | "sync",
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
  // Its open questions move to the proposal that replaced it (`proposal.created` takes them).
  return state.with(index, {
    ...earlier,
    status: "superseded",
    supersededBy: laterId,
    followups: earlier.followups.filter((followup) => followup.status !== "open"),
  });
}

/**
 * A follow-up question asked (Phase 5 WP13): on a proposal the log has and nothing has replaced,
 * under an id no question in the session has.
 */
function asked(state: readonly ProposalView[], event: FollowupAskedEvent): readonly ProposalView[] {
  const { payload } = event;
  if (holderOf(state, payload.questionId) !== undefined) {
    throw new ProjectionError(
      "proposals",
      event,
      `question ${payload.questionId} was asked before`,
    );
  }
  const [index, proposal] = find(state, payload.proposalId, event, "ask about");
  if (proposal.supersededBy !== null) {
    throw new ProjectionError(
      "proposals",
      event,
      `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}, so it takes no question`,
    );
  }
  const followup: FollowupView = {
    questionId: payload.questionId,
    turnId: payload.turnId,
    askedAbout: payload.proposalId,
    field: payload.field,
    rule: payload.rule,
    text: payload.text,
    status: "open",
    answeredBy: null,
    seq: event.seq,
    ts: event.ts,
    closedSeq: null,
    closedAt: null,
  };
  return state.with(index, { ...proposal, followups: [...proposal.followups, followup] });
}

/**
 * A follow-up question closed (Phase 5 WP13). It must be open. An answer names the proposal its
 * correction made, which replaced the one asked about and so holds the question now; a skip names
 * none. Anything else is a writer's bug, and fails the fold.
 */
function closed(
  state: readonly ProposalView[],
  event: FollowupClosedEvent,
): readonly ProposalView[] {
  const { payload } = event;
  const held = holderOf(state, payload.questionId);
  if (held === undefined) {
    throw new ProjectionError("proposals", event, `no question ${payload.questionId} to close`);
  }
  const [index, holder, at] = held;
  const followup = holder.followups[at] as FollowupView;
  if (followup.status !== "open") {
    throw new ProjectionError(
      "proposals",
      event,
      `question ${payload.questionId} was ${followup.status} before`,
    );
  }
  if (payload.outcome === "answered") {
    const answer = payload.proposalId;
    if (answer !== holder.proposalId || holder.supersedes === null) {
      throw new ProjectionError(
        "proposals",
        event,
        `question ${payload.questionId} is answered by the correction that replaced its proposal, not ${answer ?? "none"}`,
      );
    }
  } else if (payload.proposalId !== null) {
    throw new ProjectionError("proposals", event, "a skipped question names no proposal");
  }
  const close: FollowupView = {
    ...followup,
    status: payload.outcome,
    answeredBy: payload.outcome === "answered" ? payload.proposalId : null,
    closedSeq: event.seq,
    closedAt: event.ts,
  };
  return state.with(index, { ...holder, followups: holder.followups.with(at, close) });
}

/**
 * The proposal holding a question (where its id is in `followups`), its index, and the question's
 * place there. A question is held once: a replacement takes its open questions, and the replaced
 * proposal keeps only its closed ones.
 */
function holderOf(
  state: readonly ProposalView[],
  questionId: string,
): [number, ProposalView, number] | undefined {
  for (const [index, proposal] of state.entries()) {
    const at = proposal.followups.findIndex((followup) => followup.questionId === questionId);
    if (at >= 0) return [index, proposal, at];
  }
  return undefined;
}

function refuseIfSuperseded(
  proposal: ProposalView,
  event: SessionEvent,
  verb: "review" | "snooze" | "sync",
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

/**
 * A sync attempt starts (Phase 6 WP1), on the proposal it names, nothing having replaced it, whose
 * latest review is the job's: an approval or an edit. The status goes back to that decision, which
 * is what a Retry after a failure needs, and the attempt becomes the proposal's `sync`.
 */
function syncStarted(
  state: readonly ProposalView[],
  event: ProposalSyncStartedEvent,
): readonly ProposalView[] {
  const { payload } = event;
  const [index, proposal] = find(state, payload.proposalId, event, "sync");
  refuseIfSuperseded(proposal, event, "sync");
  const review = proposal.review;
  if (review?.reviewId !== payload.reviewId) {
    throw new ProjectionError(
      "proposals",
      event,
      `the sync of proposal ${proposal.proposalId} names review ${payload.reviewId}, but its latest is ${review?.reviewId ?? "none"}`,
    );
  }
  const { decision } = review;
  if (decision !== "approved" && decision !== "edited") {
    throw new ProjectionError(
      "proposals",
      event,
      `review ${payload.reviewId} of proposal ${proposal.proposalId} is ${decision}: only an approval or an edit syncs`,
    );
  }
  return state.with(index, {
    ...proposal,
    status: decision,
    sync: {
      jobId: payload.jobId,
      reviewId: payload.reviewId,
      attempt: payload.attempt,
      provider: payload.provider,
      at: event.ts,
      state: "syncing",
      records: [],
      error: null,
    },
  });
}

/**
 * A sync attempt's result (Phase 6 WP1), once, on the proposal it names, for the attempt syncing
 * there, naming the review and CRM its start named. `proposal.synced` makes the proposal `synced`,
 * and `proposal.sync_failed` makes it `failed`; a conflict leaves the status to the reopen after it.
 */
function syncEnded(
  state: readonly ProposalView[],
  event: ProposalSyncedEvent | ProposalSyncFailedEvent | ProposalSyncConflictedEvent,
): readonly ProposalView[] {
  const { payload } = event;
  const [index, proposal] = find(state, payload.proposalId, event, "sync");
  const sync = proposal.sync ?? null;
  if (sync === null || sync.jobId !== payload.jobId || sync.attempt !== payload.attempt) {
    throw new ProjectionError(
      "proposals",
      event,
      `proposal ${proposal.proposalId}'s latest sync isn't attempt ${payload.attempt} of job ${payload.jobId}, so it has no start`,
    );
  }
  if (sync.state !== "syncing") {
    throw new ProjectionError(
      "proposals",
      event,
      `attempt ${payload.attempt} of job ${payload.jobId} ended already: ${sync.state}`,
    );
  }
  if (sync.reviewId !== payload.reviewId || sync.provider !== payload.provider) {
    throw new ProjectionError(
      "proposals",
      event,
      `attempt ${payload.attempt} of job ${payload.jobId} started for review ${sync.reviewId} on ${sync.provider}`,
    );
  }
  const attempt = {
    jobId: sync.jobId,
    reviewId: sync.reviewId,
    attempt: sync.attempt,
    provider: sync.provider,
    at: event.ts,
  };
  switch (event.type) {
    case "proposal.synced":
      return state.with(index, {
        ...proposal,
        status: "synced",
        sync: { ...attempt, state: "synced", records: event.payload.records, error: null },
      });
    case "proposal.sync_failed": {
      const { kind, code, field, landed, retryable } = event.payload;
      return state.with(index, {
        ...proposal,
        status: "failed",
        sync: {
          ...attempt,
          state: "failed",
          records: [],
          error: { kind, code, field, landed, retryable },
        },
      });
    }
    case "proposal.sync_conflicted": {
      const { cause, fields, existing } = event.payload;
      return state.with(index, {
        ...proposal,
        sync: { ...attempt, state: "conflicted", records: [], error: { cause, fields, existing } },
      });
    }
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
