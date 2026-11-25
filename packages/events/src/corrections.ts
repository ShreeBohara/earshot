// The rules every writer of corrections and follow-up skips keeps (Phase 5 WP13; ADR-0038):
// SessionDO for the socket's `correct` and `followup`, and the web Worker after the seal. Like the
// review rules, they live here, pure, and each writer checks against the session's folded proposals
// before it appends; `proposalsProjection` refuses the worst of them again.
import {
  type EventEnvelope,
  PROPOSAL_TYPE_FIELDS,
  type ProposalFlaggedV1,
  type ProposalTypeV2,
  TARGET_FIELD,
} from "@earshot/core";
import type { FollowupView, ProposalView } from "./projections";
import { defaultRegistry } from "./registry";
import type { ProposalCreatedEvent } from "./types";

/**
 * What a session takes in corrections (Phase 5 WP13; ADR-0038; targets, set after a security
 * review): both writers keep them, SessionDO before the seal and the web Worker after it. A
 * correction costs no model call, but each one reads and links words, so they're bounded like
 * turns.
 */
export const CORRECTION_LIMITS = Object.freeze({
  /** How many times over one card can be corrected: the chain of `supersedes` behind it. */
  maxDepth: 5,
  /** Corrections a session takes, all told. */
  perSession: 100,
  /** Corrections a session takes in a window, as turns are limited... */
  perWindow: 30,
  /** ...of this long (the turn limit's window). */
  windowMs: 10 * 60_000,
  /**
   * Characters of words corrections carry that a session holds, all told: typed words, and a
   * dictation's segments through the web Worker's route.
   */
  typedCharsPerSession: 20_000,
});

/** Why a correction or a skip was refused. */
export type CorrectionRefusal =
  /** The field is neither `target` nor one the proposal's type has, or not the question's. */
  | "malformed"
  /** The session has no proposal with that id. */
  | "unknown_proposal"
  /** A correction replaced the proposal already; correct its replacement instead. */
  | "superseded"
  /** The proposal is syncing to the CRM (Phase 6): nothing changes it now. */
  | "syncing"
  /** The proposal synced to the CRM (Phase 6): fix it there, since Earshot can't take it back. */
  | "synced"
  /** Only a proposal still waiting for a decision can be corrected. */
  | "not_proposed"
  /** The proposal has no question with that id (or the session has none, for a skip). */
  | "unknown_question"
  /** The question was answered or skipped already. */
  | "question_closed"
  /** The card was corrected `CORRECTION_LIMITS.maxDepth` times over already. */
  | "too_deep"
  /** The session reached a correction limit: in a window, in all, or in typed words. */
  | "too_many";

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
 *    replaces a proposal under review, never a decision (undo it first), and never one syncing to
 *    the CRM or synced there (Phase 6: `syncing`, `synced`).
 * 2. The field is `target` or one the proposal's type has (`PROPOSAL_TYPE_FIELDS`).
 * 3. A named question is on the proposal (asked about it, or moved to it from one it replaced),
 *    still open, and asks for the field corrected.
 * 4. The proposal wasn't corrected `CORRECTION_LIMITS.maxDepth` times over already (`too_deep`).
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
  const sync = proposal.sync ?? null;
  if (sync?.state === "syncing") {
    return refuse("syncing", `proposal ${proposal.proposalId} is syncing to the CRM`);
  }
  if (sync?.state === "synced") {
    return refuse("synced", `proposal ${proposal.proposalId} synced to the CRM already`);
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
  const depth = correctionDepth(proposals, proposal);
  if (depth >= CORRECTION_LIMITS.maxDepth) {
    return refuse("too_deep", `proposal ${proposal.proposalId} was corrected ${depth} times over`);
  }
  const answers = proposal.followups.filter(
    (followup) => followup.status === "open" && followup.field === correction.field,
  );
  return { ok: true, proposal, answers };
}

/** How many corrections stand behind a proposal: the length of its chain of `supersedes`. */
export function correctionDepth(
  proposals: readonly ProposalView[],
  proposal: Pick<ProposalView, "supersedes">,
): number {
  const byId = new Map(proposals.map((candidate) => [candidate.proposalId, candidate]));
  let depth = 0;
  for (let at = proposal; at.supersedes !== null && depth <= CORRECTION_LIMITS.maxDepth; ) {
    const earlier = byId.get(at.supersedes);
    if (!earlier) break;
    at = earlier;
    depth += 1;
  }
  return depth;
}

/**
 * Whether a session has room for one more correction, from its folded log: the web Worker's check
 * (SessionDO keeps its own count of attempts). Corrections are the proposals that supersede
 * another; typed words are the typed utterances. Null when it has room; otherwise `too_many`, with a
 * fixed detail.
 */
export function correctionBudget(
  folded: {
    readonly proposals: readonly Pick<ProposalView, "supersedes" | "ts">[];
    readonly utterances: readonly { readonly input: string; readonly text: string }[];
  },
  now: Date,
  typedChars: number,
): { readonly reason: "too_many"; readonly detail: string } | null {
  const corrections = folded.proposals.filter((proposal) => proposal.supersedes !== null);
  if (corrections.length >= CORRECTION_LIMITS.perSession) {
    return { reason: "too_many", detail: "the session took its corrections" };
  }
  const since = now.getTime() - CORRECTION_LIMITS.windowMs;
  const recent = corrections.filter((proposal) => Date.parse(proposal.ts) > since).length;
  if (recent >= CORRECTION_LIMITS.perWindow) {
    return { reason: "too_many", detail: "too many corrections in the window" };
  }
  const typed = folded.utterances
    .filter((utterance) => utterance.input === "typed")
    .reduce((sum, utterance) => sum + utterance.text.length, 0);
  if (typed + typedChars > CORRECTION_LIMITS.typedCharsPerSession) {
    return { reason: "too_many", detail: "the session holds its typed words" };
  }
  return null;
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

/**
 * A late witness's flag, carried onto the card that replaced the flagged one (Codex on #67). A
 * correction made before its turn's second witness answered keeps the original's evidence for every
 * field it didn't change, so what the witness found about those words holds for the replacement
 * too: its flags, a downgrade of its target to a question, and the conflict. Follows `supersededBy`
 * to the card that stands, and keeps each part only while no correction on the way changed what it's
 * about. A flag with no field is the proposal's own, which a correction keeps, as `correctProposal`
 * does. Null when the flagged proposal stands, or nothing carries.
 *
 * `proposals` is the session's state before the flag: once folded, the original's target is the
 * downgraded one, which would read as a change.
 */
export function carriedFlag(
  proposals: readonly ProposalView[],
  flagged: ProposalFlaggedV1,
): ProposalFlaggedV1 | null {
  const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  let at = byId.get(flagged.proposalId);
  if (!at || at.supersededBy === null) return null;
  const changed = new Set<string>();
  // The chain is at most `maxDepth` long; the bound keeps a malformed one from looping.
  for (let steps = 0; at.supersededBy !== null; steps += 1) {
    const later = byId.get(at.supersededBy);
    if (!later || steps >= CORRECTION_LIMITS.maxDepth) return null;
    for (const field of changedBetween(at, later)) changed.add(field);
    at = later;
  }
  const flags = flagged.flags.filter(
    (flag) => flag.field === undefined || !changed.has(flag.field),
  );
  if (flags.length === 0) return null;
  return {
    ...flagged,
    proposalId: at.proposalId,
    flags,
    target: changed.has(TARGET_FIELD) ? null : flagged.target,
    conflict:
      flagged.conflict !== null && !changed.has(flagged.conflict.field) ? flagged.conflict : null,
  };
}

/** What a correction changed between a proposal and the one that replaced it: fields, and `target`. */
function changedBetween(earlier: ProposalView, later: ProposalView): string[] {
  const names = new Set([...Object.keys(earlier.fields), ...Object.keys(later.fields)]);
  const changed = [...names].filter((name) => !sameJson(earlier.fields[name], later.fields[name]));
  if (!sameJson(earlier.target, later.target)) changed.push(TARGET_FIELD);
  return changed;
}

/** Whether two JSON values are the same, whatever the order of their keys. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  const a = Object.entries(left).filter(([, value]) => value !== undefined);
  const b = Object.entries(right).filter(([, value]) => value !== undefined);
  const others = new Map(b);
  return a.length === b.length && a.every(([key, value]) => sameJson(value, others.get(key)));
}
