// The rules every writer of reviews and snoozes keeps (Phase 5 spec §4.1, ADR-0032): SessionDO,
// for the socket's reviews and its own, and the web Worker, after the seal. JSON Schema can't
// express them, so they live here, pure, and each writer checks against the session's folded
// proposals before it appends. `proposalsProjection` refuses the worst of them again, so a writer
// that skipped this check still can't commit a log that won't replay.
import type { LikelyEditTier, ProposalReviewedV2, ProposalSnoozedV1 } from "@earshot/core";
import type { ProposalView } from "./projections";

/** Why a review or a snooze was refused. */
export type ReviewRefusal =
  /** A rule the schema can't express: a field set when it mustn't be, or missing when it must. */
  | "malformed"
  /** The session has no proposal with that id. */
  | "unknown_proposal"
  /** A correction replaced the proposal; review its replacement instead. */
  | "superseded"
  /** Approving, editing, rejecting, or snoozing needs a proposal that's still `proposed`. */
  | "not_proposed"
  /** A reopen must name the proposal's latest review. */
  | "not_latest"
  /** The latest review is a reopen itself, so there's no decision to reopen. */
  | "nothing_to_reopen"
  /** The linker asked: approving needs one of the records it offered. */
  | "target_required"
  /** The record chosen is none of those the proposal offered. */
  | "target_not_offered"
  /** A proposal whose record is `none` can't be approved; it can be rejected or corrected. */
  | "no_target"
  /** "Accept all" takes only unmarked proposals. */
  | "marked"
  /** Policy and system reviews come only from SessionDO, never from a client. */
  | "machine_only"
  /** A policy approves only an unmarked, linked proposal that doesn't replace another. */
  | "policy_excluded";

export type ReviewCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReviewRefusal; readonly detail: string };

/** A request's check: the index of the first refused item, with why. */
export type ReviewsCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly index: number;
      readonly reason: ReviewRefusal;
      readonly detail: string;
    };

/**
 * A proposal's likely-edit tier. `tierOf` in `@earshot/understanding/tiers` (Phase 5 WP4) fits,
 * since it returns `{ tier, reasons, nameNote }`; until it lands, use `anyFlagTier`.
 */
export type TierOf = (proposal: ProposalView) => { readonly tier: LikelyEditTier };

export interface ReviewRuleContext {
  readonly tierOf: TierOf;
  /**
   * Who made the review: `client` for a person's, sent over the socket or to the web route;
   * `session` for SessionDO's own policy and system reviews.
   */
  readonly from: "client" | "session";
}

/**
 * WP1's stand-in for `tierOf`: any flag marks a proposal, so it counts as `loud`, the cautious
 * reading, and a proposal with none is unmarked. WP4's function refines this (a lone
 * `self_correction` is unmarked there, for one). It's for the checks here, not for display.
 */
export const anyFlagTier: TierOf = (proposal) => ({
  tier: proposal.riskFlags.length > 0 ? "loud" : "none",
});

const ok = { ok: true } as const;

function refuse(reason: ReviewRefusal, detail: string): ReviewCheck {
  return { ok: false, reason, detail };
}

/**
 * Checks one review against the session's proposals, as the projection folded them before it.
 * `review` is the payload the writer is about to append, with `by` and `syncEligibleAt` filled.
 * The rules, in the order they're checked:
 *
 * 1. Its shape: the cross-field rules `ProposalReviewedV2` documents, and that a Phase 5 writer
 *    sets `seen`, `input`, `surface`, and `by`. A person reviews in `single` or `batch` mode, on a
 *    surface of their own, with an input; SessionDO's `policy` approvals and `system` reopens (for
 *    a later flag) have no sign-in, no input, the `session` surface, and zero timings. A batch
 *    approves or undoes, and only approvals and edits choose a record.
 * 2. Who made it: `policy` and `system` only from SessionDO, and SessionDO makes nothing else.
 * 3. The proposal: it exists and nothing has superseded it.
 * 4. The decision: approving, editing, and rejecting need `proposed`. Approving and editing need
 *    a record unless the target is `none`: for an ask, one of the candidates; otherwise the
 *    proposal's own record or a candidate, if the review names one; a record offered at review
 *    time (`seen.relinked`) counts as offered. A reopen names the latest review, a decision,
 *    and a system reopen (decision 15) only an approval or an edit.
 * 5. The mode: a batch approves only unmarked proposals (`tierOf` is `none`), and a policy only an
 *    unmarked, linked proposal that doesn't supersede another.
 */
export function checkReview(
  proposals: readonly ProposalView[],
  review: ProposalReviewedV2,
  ctx: ReviewRuleContext,
): ReviewCheck {
  const shape = checkShape(review);
  if (!shape.ok) return shape;

  const machine = review.mode === "policy" || review.mode === "system";
  if (machine && ctx.from !== "session") {
    return refuse("machine_only", `a ${review.mode} review comes only from SessionDO`);
  }
  if (!machine && ctx.from === "session") {
    return refuse(
      "malformed",
      `SessionDO writes only policy and system reviews, not ${review.mode}`,
    );
  }

  const proposal = proposals.find((candidate) => candidate.proposalId === review.proposalId);
  if (!proposal) return refuse("unknown_proposal", `no proposal ${review.proposalId}`);
  if (proposal.supersededBy !== null) {
    return refuse(
      "superseded",
      `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}`,
    );
  }

  if (review.decision === "reopened") {
    const latest = proposal.review;
    if (latest === null || latest.reviewId !== review.undoes) {
      return refuse(
        "not_latest",
        `the reopen names review ${review.undoes}, but proposal ${proposal.proposalId}'s latest review is ${latest?.reviewId ?? "none"}`,
      );
    }
    if (latest.decision === "reopened") {
      return refuse("nothing_to_reopen", `review ${latest.reviewId} is a reopen itself`);
    }
    if (review.mode === "system" && latest.decision === "rejected") {
      return refuse("nothing_to_reopen", "a later flag reopens only an approval or an edit");
    }
    return ok;
  }

  if (proposal.status !== "proposed") {
    return refuse(
      "not_proposed",
      `proposal ${proposal.proposalId} is ${proposal.status}, so it takes no ${review.decision} review`,
    );
  }
  if (review.decision !== "rejected") {
    const target = checkTarget(proposal, review);
    if (!target.ok) return target;
  }

  if (review.mode === "batch" && ctx.tierOf(proposal).tier !== "none") {
    return refuse("marked", `"accept all" can't take proposal ${proposal.proposalId}: it's marked`);
  }
  if (review.mode === "policy") {
    if (ctx.tierOf(proposal).tier !== "none") {
      return refuse("policy_excluded", `proposal ${proposal.proposalId} is marked`);
    }
    if (proposal.target.decision !== "linked") {
      return refuse("policy_excluded", `proposal ${proposal.proposalId}'s record isn't linked`);
    }
    if (proposal.supersedes !== null) {
      return refuse("policy_excluded", `proposal ${proposal.proposalId} replaces another`);
    }
  }
  return ok;
}

/**
 * Checks one request's reviews: a `review` message, or a web request. Each proposal and each
 * review id appears once, and the batch reviews all carry one `batchId` (a batch longer than a
 * request goes in several requests with the same id). Each review is then checked against the
 * proposals as they were before the request, which is exact, since no proposal appears twice.
 */
export function checkReviews(
  proposals: readonly ProposalView[],
  reviews: readonly ProposalReviewedV2[],
  ctx: ReviewRuleContext,
): ReviewsCheck {
  const reviewIds = new Set<string>();
  const proposalIds = new Set<string>();
  let batchId: string | null = null;
  for (const [index, review] of reviews.entries()) {
    if (reviewIds.has(review.reviewId)) {
      return { ok: false, index, reason: "malformed", detail: "a review id appears twice" };
    }
    if (proposalIds.has(review.proposalId)) {
      return { ok: false, index, reason: "malformed", detail: "a proposal appears twice" };
    }
    reviewIds.add(review.reviewId);
    proposalIds.add(review.proposalId);
    if (review.batchId !== null) {
      if (batchId !== null && batchId !== review.batchId) {
        return { ok: false, index, reason: "malformed", detail: "one request, one batch id" };
      }
      batchId = review.batchId;
    }
  }
  for (const [index, review] of reviews.entries()) {
    const check = checkReview(proposals, review, ctx);
    if (!check.ok) return { ...check, index };
  }
  return ok;
}

/**
 * Checks a snooze, or a wake (`until: null`): the proposal exists, nothing has superseded it,
 * and it's still `proposed`, since a snooze defers a decision.
 */
export function checkSnooze(
  proposals: readonly ProposalView[],
  snooze: ProposalSnoozedV1,
): ReviewCheck {
  const proposal = proposals.find((candidate) => candidate.proposalId === snooze.proposalId);
  if (!proposal) return refuse("unknown_proposal", `no proposal ${snooze.proposalId}`);
  if (proposal.supersededBy !== null) {
    return refuse(
      "superseded",
      `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}`,
    );
  }
  if (proposal.status !== "proposed") {
    return refuse(
      "not_proposed",
      `proposal ${proposal.proposalId} is ${proposal.status}, so there's nothing to defer`,
    );
  }
  return ok;
}

/** The rules a review's own fields must keep (step 1 of `checkReview`). */
function checkShape(review: ProposalReviewedV2): ReviewCheck {
  const { decision, mode } = review;
  const decides = decision === "approved" || decision === "edited";
  const reopens = decision === "reopened";
  const pairs: [boolean, boolean, string][] = [
    [mode === "batch", review.batchId !== null, "batchId is set exactly when mode is batch"],
    [mode === "policy", review.policy !== null, "policy is set exactly when mode is policy"],
    [reopens, review.undoes !== null, "undoes is set exactly when the decision is reopened"],
    [reopens, review.reason !== null, "reason is set exactly when the decision is reopened"],
    [decision === "edited", review.editDiff !== undefined, "editDiff comes exactly with an edit"],
    [decides, review.syncEligibleAt !== null, "syncEligibleAt comes exactly with an approval"],
  ];
  for (const [when, set, rule] of pairs) {
    if (when !== set) return refuse("malformed", rule);
  }
  if (review.editDiff !== undefined && Object.keys(review.editDiff).length === 0) {
    return refuse("malformed", "an edit changes at least one field");
  }
  if (review.target !== null && !decides) {
    return refuse("malformed", "only an approval or an edit chooses a record");
  }
  if (review.seen === null || review.input === null || review.surface === null) {
    return refuse("malformed", "a review says what was seen, with what input, and where");
  }
  if (review.by === null) return refuse("malformed", "a review says who made it");

  if (mode === "policy" || mode === "system") {
    const expected = mode === "policy" ? decision === "approved" : reopens;
    if (!expected) return refuse("malformed", `a ${mode} review can't be ${decision}`);
    if (mode === "system" && review.reason !== "flagged") {
      return refuse("malformed", "a system reopen is for a later flag");
    }
    const { timing } = review;
    const unattended =
      review.by.auth === null &&
      review.input === "none" &&
      review.surface === "session" &&
      timing.decisionMs === 0 &&
      timing.handlingMs === 0;
    if (!unattended) {
      return refuse(
        "malformed",
        `a ${mode} review has no sign-in or input, the session surface, and no time`,
      );
    }
    return ok;
  }
  if (review.reason === "flagged") return refuse("malformed", "a reopen for a flag is SessionDO's");
  if (mode === "batch" && !(decision === "approved" || reopens)) {
    return refuse("malformed", `a batch approves or undoes, so it can't be ${decision}`);
  }
  if (review.input === "none" || review.surface === "session") {
    return refuse("malformed", "a person reviews with an input, on a surface of their own");
  }
  return ok;
}

/** The record an approval or an edit takes (step 4 of `checkReview`). */
function checkTarget(proposal: ProposalView, review: ProposalReviewedV2): ReviewCheck {
  const { target } = proposal;
  if (target.decision === "none") {
    return refuse(
      "no_target",
      `proposal ${proposal.proposalId} names no record: reject it or correct it`,
    );
  }
  const chosen = review.target;
  if (chosen === null) {
    if (target.decision !== "ask") return ok;
    return refuse("target_required", `proposal ${proposal.proposalId} asks which record it is`);
  }
  const offered = new Set<string | null>(target.candidates.map((candidate) => candidate.entityId));
  if (target.decision !== "ask") offered.add(target.entityId);
  if (review.seen?.relinked) offered.add(review.seen.relinked);
  if (!offered.has(chosen.entityId)) {
    return refuse("target_not_offered", `proposal ${proposal.proposalId} didn't offer that record`);
  }
  return ok;
}
