// The rules every writer of corrections and follow-up skips keeps (Phase 5 WP13; ADR-0038):
// SessionDO for the socket's `correct` and `followup`, and the web Worker after the seal. Like the
// review rules, they live here, pure, and each writer checks against the session's folded proposals
// before it appends; `proposalsProjection` refuses the worst of them again.
import {
  type EventEnvelope,
  PROPOSAL_TYPE_FIELDS,
  type ProposalTypeV2,
  TARGET_FIELD,
} from "@earshot/core";
import type { FollowupView, ProposalView } from "./projections";
import { defaultRegistry } from "./registry";
import type { ProposalCreatedEvent } from "./types";

/** Why a correction or a skip was refused. */
export type CorrectionRefusal =
  /** The field is neither `target` nor one the proposal's type has, or not the question's. */
  | "malformed"
  /** The session has no proposal with that id. */
  | "unknown_proposal"
  /** A correction replaced the proposal already; correct its replacement instead. */
  | "superseded"
  /** Only a proposal still waiting for a decision can be corrected. */
  | "not_proposed"
  /** The proposal has no question with that id (or the session has none, for a skip). */
  | "unknown_question"
  /** The question was answered or skipped already. */
  | "question_closed";

export type CorrectionCheck =
  | {
      readonly ok: true;
      readonly proposal: ProposalView;
      /** The open questions on the proposal the correction answers, in the order asked. */
      readonly answers: readonly FollowupView[];
    }
  | { readonly ok: false; readonly reason: CorrectionRefusal; readonly detail: string };

export type SkipCheck =
  | { readonly ok: true; readonly question: FollowupView }
  | { readonly ok: false; readonly reason: CorrectionRefusal; readonly detail: string };

/** What a correction names, as both writers receive it. */
export interface CorrectionTarget {
  readonly proposalId: string;
  /** `target`, or one of the proposal type's fields. */
  readonly field: string;
  /** The follow-up question it answers, if it answers one. */
  readonly questionId?: string | null | undefined;
}

/** What a proposal of `type` can be corrected on: its record, then its type's fields. */
export function correctableFields(type: ProposalTypeV2): readonly string[] {
  return [TARGET_FIELD, ...PROPOSAL_TYPE_FIELDS[type]];
}

function refuse(reason: CorrectionRefusal, detail: string) {
  return { ok: false, reason, detail } as const;
}

/**
 * Checks a correction against the session's proposals, as the projection folded them before it:
 *
 * 1. The proposal exists, nothing has replaced it, and it still waits for a decision: a correction
 *    replaces a proposal under review, never a decision (undo it first).
 * 2. The field is `target` or one the proposal's type has (`PROPOSAL_TYPE_FIELDS`).
 * 3. A named question is on the proposal (asked about it, or moved to it from one it replaced),
 *    still open, and asks for the field corrected.
 *
 * The answer lists the open questions the correction answers: the named one, and any other open
 * question on the proposal asking for the same field. The writers close each, `answered`, right
 * after the proposal the correction made.
 */
export function checkCorrection(
  proposals: readonly ProposalView[],
  correction: CorrectionTarget,
): CorrectionCheck {
  const proposal = proposals.find((candidate) => candidate.proposalId === correction.proposalId);
  if (!proposal) return refuse("unknown_proposal", `no proposal ${correction.proposalId}`);
  if (proposal.supersededBy !== null) {
    return refuse(
      "superseded",
      `proposal ${proposal.proposalId} was superseded by ${proposal.supersededBy}`,
    );
  }
  if (proposal.status !== "proposed") {
    return refuse(
      "not_proposed",
      `proposal ${proposal.proposalId} is ${proposal.status}, so it takes no correction`,
    );
  }
  if (!correctableFields(proposal.type).includes(correction.field)) {
    return refuse("malformed", `a ${proposal.type} has no field ${correction.field}`);
  }
  const questionId = correction.questionId ?? null;
  if (questionId !== null) {
    const question = proposal.followups.find((followup) => followup.questionId === questionId);
    if (!question) {
      return refuse("unknown_question", `proposal ${proposal.proposalId} has no ${questionId}`);
    }
    if (question.status !== "open") {
      return refuse("question_closed", `question ${questionId} was ${question.status}`);
    }
    if (question.field !== correction.field) {
      return refuse("malformed", `question ${questionId} asks for ${question.field}`);
    }
  }
  const answers = proposal.followups.filter(
    (followup) => followup.status === "open" && followup.field === correction.field,
  );
  return { ok: true, proposal, answers };
}

/**
 * Checks a skip: the question is in the session, held by a proposal nothing has replaced (an open
 * question moves with its proposal's corrections), and still open.
 */
export function checkFollowupSkip(
  proposals: readonly ProposalView[],
  questionId: string,
): SkipCheck {
  for (const proposal of proposals) {
    const question = proposal.followups.find((followup) => followup.questionId === questionId);
    if (!question) continue;
    if (question.status !== "open") {
      return refuse("question_closed", `question ${questionId} was ${question.status}`);
    }
    return { ok: true, question };
  }
  return refuse("unknown_question", `no question ${questionId}`);
}

/**
 * The linker that resolved a proposal's record, from its `proposal.created` in `log`: what a
 * correction of one of its fields carries over (the projection doesn't keep it). Null when the log
 * has no such proposal, or it was upcast from v1.
 */
export function linkerOf(log: readonly EventEnvelope[], proposalId: string): string | null {
  for (const event of log) {
    if (event.type !== "proposal.created" || event.payload.proposalId !== proposalId) continue;
    return (defaultRegistry.toLatest(event) as ProposalCreatedEvent).payload.linker;
  }
  return null;
}
