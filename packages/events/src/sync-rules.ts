// The rules the sync outbox keeps when it appends its own events (Phase 6 spec §4.1, decisions 4 and
// 5; ADR-0040): a job's start, the point of no return, and the one result each start gets. Like the
// review rules, they live here, pure, and the writer (WP3's `appendSyncEvents`, under the session's
// lock) checks each event against the session as its log folds before it appends;
// `proposalsProjection` refuses the worst of them again, so a writer that skipped this check still
// can't commit a log that won't replay.
import type {
  ExternalRef,
  ProposalSyncConflictedV1,
  ProposalSyncedV1,
  ProposalSyncFailedV1,
  ProposalSyncStartedV1,
} from "@earshot/core";
import type { ProposalView, SessionView } from "./projections";

/** A sync event as the outbox is about to append it: its type and its payload. */
export type SyncEventInput =
  | { readonly type: "proposal.sync_started"; readonly payload: ProposalSyncStartedV1 }
  | { readonly type: "proposal.synced"; readonly payload: ProposalSyncedV1 }
  | { readonly type: "proposal.sync_failed"; readonly payload: ProposalSyncFailedV1 }
  | { readonly type: "proposal.sync_conflicted"; readonly payload: ProposalSyncConflictedV1 };

/** Why a sync event was refused. */
export type SyncRefusal =
  /** A rule the schema can't express: a field set when it mustn't be, or a value of the wrong kind. */
  | "malformed"
  /** The session isn't sealed: only a sealed session syncs (Phase 5's rule). */
  | "unsealed"
  /** The job's review isn't its proposal's latest: an undo or a later review came first. */
  | "not_latest"
  /** The latest review neither approves nor edits, so there's nothing to sync. */
  | "not_approved"
  /** A correction replaced the proposal. */
  | "superseded"
  /** Another attempt is syncing the proposal, or this one started already. */
  | "syncing"
  /** The job's last attempt synced, conflicted, or failed for good, or this attempt isn't later. */
  | "not_retryable"
  /** A result for an attempt that isn't the one syncing: it never started, or a later one did. */
  | "unknown_attempt"
  /** The attempt has its result already. */
  | "settled";

export type SyncCheck =
  | {
      readonly ok: true;
      /** The proposal the event is about: the one whose latest review the job syncs. */
      readonly proposal: ProposalView;
    }
  | { readonly ok: false; readonly reason: SyncRefusal; readonly detail: string };

function refuse(reason: SyncRefusal, detail: string): SyncCheck {
  return { ok: false, reason, detail };
}

/** The kinds of failure that name a field: a refused value, or a plan that can't read one. */
const FIELD_KINDS: ReadonlySet<string> = new Set(["validation", "unmapped", "unsupported"]);

/**
 * A CRM's error code or category, as a failure may carry it: letters, digits, and `_.:-`, starting
 * with a letter or digit (`VALIDATION_ERROR`, `invalid_grant`, `429`). Never the CRM's message,
 * which can quote a record.
 */
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Checks one sync event against the session's proposals and session, as the projections folded
 * them before it, in the order these rules are listed:
 *
 * 1. The session is sealed, whatever the event.
 * 2. Its shape, beyond the schema: a start names a connection exactly when its CRM isn't the demo
 *    CRM; a record's link is `http` or `https`, since the inbox shows it as a link; a success names
 *    each planned write once; a failure names a field only for a refused value or a plan that
 *    can't read one, and carries a code, never a message; a conflict lists the fields that moved
 *    exactly when its cause is `moved`, and names an existing record only when it's `duplicate`.
 * 3. A start (`proposal.sync_started`): its review is the latest review of a proposal, approving
 *    or editing it; nothing replaced that proposal; no attempt is syncing it; and if the proposal's
 *    last attempt was this job's, that attempt failed and may be retried, and this one is later.
 *    A job syncs one review to one CRM, and a review syncs through one job.
 * 4. A result (`proposal.synced`, `proposal.sync_failed`, `proposal.sync_conflicted`): the attempt
 *    is the one syncing a proposal (`unknown_attempt` otherwise), it has no result yet
 *    (`settled`), and it names the review and CRM its start named.
 *
 * On success it answers with the proposal the event is about, for the writer's audit rows.
 */
export function checkSyncEvent(
  proposals: readonly ProposalView[],
  session: Pick<SessionView, "sealedAt"> | null,
  event: SyncEventInput,
): SyncCheck {
  if (!session?.sealedAt) return refuse("unsealed", "only a sealed session syncs");
  const shape = checkShape(event);
  if (shape !== null) return refuse("malformed", shape);
  return event.type === "proposal.sync_started"
    ? checkStart(proposals, event.payload)
    : checkResult(proposals, event.payload);
}

/** A start's rules (step 3 of `checkSyncEvent`). */
function checkStart(proposals: readonly ProposalView[], start: ProposalSyncStartedV1): SyncCheck {
  const proposal = proposals.find((candidate) => candidate.review?.reviewId === start.reviewId);
  const review = proposal?.review;
  if (!proposal || !review) {
    return refuse("not_latest", `review ${start.reviewId} isn't any proposal's latest review`);
  }
  if (proposal.supersededBy !== null) {
    return refuse(
      "superseded",
      `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}`,
    );
  }
  if (review.decision !== "approved" && review.decision !== "edited") {
    return refuse("not_approved", `review ${review.reviewId} is ${review.decision}`);
  }
  const last = proposal.sync ?? null;
  if (last?.state === "syncing") {
    return refuse(
      "syncing",
      `attempt ${last.attempt} of job ${last.jobId} is syncing proposal ${proposal.proposalId}`,
    );
  }
  if (last !== null && last.jobId === start.jobId) {
    if (last.reviewId !== start.reviewId || last.provider !== start.provider) {
      return refuse(
        "malformed",
        `job ${last.jobId} syncs review ${last.reviewId} to ${last.provider}, whatever its attempt`,
      );
    }
    if (last.state !== "failed" || !last.error.retryable) {
      const ended = last.state === "failed" ? "failed for good" : last.state;
      return refuse("not_retryable", `attempt ${last.attempt} of job ${last.jobId} ${ended}`);
    }
    if (start.attempt <= last.attempt) {
      return refuse(
        "not_retryable",
        `job ${start.jobId} made attempt ${last.attempt} already, so its next is later than ${start.attempt}`,
      );
    }
  } else if (last !== null && last.reviewId === start.reviewId) {
    return refuse("malformed", `review ${start.reviewId} syncs through job ${last.jobId}`);
  }
  return { ok: true, proposal };
}

/** A result's rules (step 4 of `checkSyncEvent`). */
function checkResult(
  proposals: readonly ProposalView[],
  result: ProposalSyncedV1 | ProposalSyncFailedV1 | ProposalSyncConflictedV1,
): SyncCheck {
  const proposal = proposals.find(
    (candidate) =>
      candidate.sync?.jobId === result.jobId && candidate.sync.attempt === result.attempt,
  );
  const sync = proposal?.sync;
  if (!proposal || !sync) {
    return refuse(
      "unknown_attempt",
      `no proposal's latest sync is attempt ${result.attempt} of job ${result.jobId}`,
    );
  }
  if (sync.state !== "syncing") {
    return refuse("settled", `attempt ${result.attempt} of job ${result.jobId} ${sync.state}`);
  }
  if (sync.reviewId !== result.reviewId || sync.provider !== result.provider) {
    return refuse(
      "malformed",
      `attempt ${result.attempt} of job ${result.jobId} started for review ${sync.reviewId} on ${sync.provider}`,
    );
  }
  return { ok: true, proposal };
}

/** The rules an event's own fields keep (step 2 of `checkSyncEvent`), or null when it keeps them. */
function checkShape(event: SyncEventInput): string | null {
  switch (event.type) {
    case "proposal.sync_started": {
      const demo = event.payload.provider === "demo";
      if (demo !== (event.payload.connectionId === null)) {
        return "a start names a connection exactly when its CRM isn't the demo CRM";
      }
      return null;
    }
    case "proposal.synced": {
      const { records } = event.payload;
      if (new Set(records.map((record) => record.write)).size !== records.length) {
        return "a sync names each planned write once";
      }
      return linkProblem(records.map((record) => record.ref));
    }
    case "proposal.sync_failed": {
      const { kind, code, field, landed } = event.payload;
      if (field !== null && !FIELD_KINDS.has(kind)) {
        return `a ${kind} failure names no field`;
      }
      if (code !== null && !ERROR_CODE.test(code)) {
        return "a failure carries the CRM's code, never its message";
      }
      return linkProblem(landed);
    }
    case "proposal.sync_conflicted": {
      const { cause, fields, existing } = event.payload;
      if ((cause === "moved") !== Object.keys(fields).length > 0) {
        return "a conflict lists the fields that moved exactly when its cause is moved";
      }
      if (existing !== null && cause !== "duplicate") {
        return "only a duplicate names the record that exists";
      }
      return linkProblem(existing === null ? [] : [existing]);
    }
  }
}

/** Why a record's link can't be shown as one, or null: links are `http` or `https`. */
function linkProblem(refs: readonly ExternalRef[]): string | null {
  for (const ref of refs) {
    if (ref.url !== null && !/^https?:\/\//i.test(ref.url)) {
      return "a record's link is http or https";
    }
  }
  return null;
}
