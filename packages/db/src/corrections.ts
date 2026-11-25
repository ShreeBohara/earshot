// Corrections and follow-up skips in Postgres (Phase 5 WP13, docs/adr/0038): the web Worker's writes
// once a session is sealed, as `writeSessionReviews` is for reviews (docs/adr/0032), one
// transaction each: the session's lock, a log that holds `session.sealed`, the writers' rules, the
// append, and the projections. A correction decides nothing (it makes a proposal for the rep to
// review), so neither writes an audit row or needs the signing key.
//
// Reading the words is the caller's: `writeSessionCorrection` hands the proposal and the new
// utterances to a `read` function (the route runs `correctProposal` over the workspace's mirror), so
// this package needs neither the linker's context nor the mirror's rows.

import {
  type CorrectionRefusal,
  checkCorrection,
  checkFollowupSkip,
  correctionBudget,
  defaultProjections,
  type EventDraft,
  linkerOf,
  type ProposalView,
  replay,
  type SessionView,
} from "@earshot/events";
import type { CorrectedProposal, CorrectionResult } from "@earshot/understanding/correct";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  appendEvents,
  isStoredUuid,
  lastSeqInWorkspace,
  lockSession,
  readEvents,
} from "./event-store";
import { rebuildProjections } from "./projections";

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/** One utterance a correction appends: `utterance.final` v3 as the reader reads it. */
export interface CorrectionUtteranceV3 {
  readonly utteranceId: string;
  readonly text: string;
  readonly confidence: number;
  readonly words?: { w: string; startMs: number; endMs: number; confidence: number }[];
  readonly startMs: number;
  readonly endMs: number;
  readonly witness: "biased";
  readonly input: "speech" | "typed";
}

/**
 * The words of a correction, before they're placed on the session's clock: typed text, or a
 * dictation's segments, timed from the dictation's own start.
 */
export type CorrectionWords =
  | { readonly input: "typed"; readonly text: string }
  | {
      readonly input: "speech";
      readonly utterances: readonly {
        readonly text: string;
        readonly confidence: number;
        readonly startMs: number;
        readonly endMs: number;
        readonly words?: readonly {
          readonly w: string;
          readonly startMs: number;
          readonly endMs: number;
          readonly confidence: number;
        }[];
      }[];
    };

export interface SessionCorrectionRequest {
  /** The client's id: resends are idempotent by it, and the new proposal's id derives from it. */
  readonly correctionId: string;
  readonly proposalId: string;
  /** `target`, or one of the proposal type's fields. */
  readonly field: string;
  readonly questionId: string | null;
  readonly words: CorrectionWords;
}

/** What `read` gets: the proposal to correct, the words placed on the clock, and the session. */
export interface CorrectionReadInput {
  /** The proposal, with the linker its `proposal.created` names. */
  readonly original: ProposalView & { readonly linker: string | null };
  readonly field: string;
  readonly utterances: readonly CorrectionUtteranceV3[];
  readonly session: SessionView;
  readonly proposals: readonly ProposalView[];
}

export type SessionCorrectionOutcome =
  | {
      readonly ok: true;
      /** `now` if this request wrote it, `before` if the log already held it (a resend). */
      readonly recorded: "now" | "before";
      /** The superseding proposal's id. */
      readonly proposalId: string;
      /** Its `proposal.created`'s seq. */
      readonly seq: number;
      /** The questions it answered, by id. */
      readonly answered: readonly string[];
      readonly lastSeq: number;
    }
  | {
      readonly ok: false;
      /**
       * - `not_found`: the session isn't in the workspace.
       * - `not_sealed`: Postgres doesn't hold `session.sealed`, so `SessionDO` may still write.
       * - `refused`: a writer's rule (`refusal` says which).
       * - `unreadable`: the words hold no value of the field's kind; nothing was written.
       */
      readonly reason: "not_found" | "not_sealed" | "refused" | "unreadable";
      readonly refusal?: CorrectionRefusal;
      readonly detail?: string;
      /** For `unreadable`: what `read` said. */
      readonly unreadable?: Extract<CorrectionResult, { ok: false }>;
    };

export interface SessionCorrectionOptions {
  /** The writer's clock: each appended event's `ts`. */
  readonly now: Date;
  /** Event and utterance ids: UUIDv7 in the app. */
  readonly newId: () => string;
  /** The superseding proposal's id: `correctionProposalId` from `@earshot/core`. */
  readonly proposalIdFor: (sessionId: string, correctionId: string) => Promise<string>;
  /** Reads the words into a proposal: `correctProposal` with the caller's linker context. */
  readonly read: (input: CorrectionReadInput) => Promise<CorrectionResult>;
}

/**
 * The session's last audio time: where a typed correction, or a dictation made after the session,
 * sits on its clock. The end of its latest utterance, or 0 for a session with none.
 */
export function lastAudioMs(utterances: readonly { readonly endMs: number }[]): number {
  return utterances.reduce((latest, utterance) => Math.max(latest, utterance.endMs), 0);
}

/** The correction's words as `utterance.final` v3, placed at the session's last audio time. */
export function correctionUtterances(
  words: CorrectionWords,
  at: number,
  newId: () => string,
): CorrectionUtteranceV3[] {
  if (words.input === "typed") {
    return [
      {
        utteranceId: newId(),
        text: words.text,
        confidence: 1,
        startMs: at,
        endMs: at,
        witness: "biased",
        input: "typed",
      },
    ];
  }
  return words.utterances.map((segment) => ({
    utteranceId: newId(),
    text: segment.text,
    confidence: segment.confidence,
    ...(segment.words
      ? {
          words: segment.words.map((word) => ({
            w: word.w,
            startMs: at + word.startMs,
            endMs: at + word.endMs,
            confidence: word.confidence,
          })),
        }
      : {}),
    startMs: at + segment.startMs,
    endMs: at + Math.max(segment.endMs, segment.startMs),
    witness: "biased",
    input: "speech",
  }));
}

/**
 * The web Worker's correction (spec WP13 step 5), in the caller's `withTenant` transaction:
 *
 * 1. Takes the session's advisory lock, the one `appendEvents` takes.
 * 2. Reads the log. Without `session.sealed` it answers `not_sealed` and writes nothing.
 * 3. Folds it. A log that already holds the proposal the correction's id derives to is a resend,
 *    answered with that proposal. Otherwise `checkCorrection`: a proposal still under review, a
 *    field it has, any question it names open on it and for that field, and a chain of corrections
 *    behind it shorter than the cap; then the session's limits (`correctionBudget`): corrections in
 *    all and in the window, and typed words.
 * 4. Places the words at the session's last audio time and hands them to `read`. Words with no
 *    value of the field's kind are `unreadable`, and nothing is appended.
 * 5. Appends the utterances, the superseding `proposal.created`, and a `followup.closed`
 *    (`answered`) for each open question on the proposal that asked for the field, then rebuilds
 *    the projections.
 */
export async function writeSessionCorrection<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  request: SessionCorrectionRequest,
  options: SessionCorrectionOptions,
): Promise<SessionCorrectionOutcome> {
  if (!isStoredUuid(sessionId)) return { ok: false, reason: "not_found" };
  await lockSession(tx, sessionId);
  const lastSeq = await lastSeqInWorkspace(tx, sessionId);
  if (lastSeq === undefined) return { ok: false, reason: "not_found" };
  const log = await readEvents(tx, sessionId);
  if (!log.some((event) => event.type === "session.sealed")) {
    return { ok: false, reason: "not_sealed" };
  }
  const { session, utterances, proposals } = replay(log, defaultProjections);
  if (!session) return { ok: false, reason: "not_found" };

  const proposalId = await options.proposalIdFor(sessionId, request.correctionId);
  const before = proposals.find((proposal) => proposal.proposalId === proposalId);
  if (before) {
    // A resend, whatever it carries now: the first one's proposal stands.
    return {
      ok: true,
      recorded: "before",
      proposalId,
      seq: before.seq,
      answered: before.followups
        .filter((followup) => followup.answeredBy === proposalId)
        .map((followup) => followup.questionId),
      lastSeq,
    };
  }

  const check = checkCorrection(proposals, request);
  if (!check.ok) {
    return { ok: false, reason: "refused", refusal: check.reason, detail: check.detail };
  }
  // The session's correction limits (ADR-0038): in all, in the window, and in typed words.
  const typedChars = request.words.input === "typed" ? request.words.text.length : 0;
  const over = correctionBudget({ proposals, utterances }, options.now, typedChars);
  if (over) return { ok: false, reason: "refused", refusal: over.reason, detail: over.detail };
  const placed = correctionUtterances(request.words, lastAudioMs(utterances), options.newId);
  const result = await options.read({
    original: { ...check.proposal, linker: linkerOf(log, check.proposal.proposalId) },
    field: request.field,
    utterances: placed,
    session,
    proposals,
  });
  if (!result.ok) return { ok: false, reason: "unreadable", unreadable: result };

  const ts = options.now.toISOString();
  const drafts: EventDraft[] = [
    ...placed.map((utterance) => ({
      id: options.newId(),
      ts,
      type: "utterance.final",
      schemaVersion: 3,
      payload: { ...utterance } as Record<string, unknown>,
    })),
    {
      id: options.newId(),
      ts,
      type: "proposal.created",
      schemaVersion: 2,
      payload: proposalPayload(proposalId, result.proposal),
    },
    ...check.answers.map((question) => ({
      id: options.newId(),
      ts,
      type: "followup.closed",
      schemaVersion: 1,
      payload: { questionId: question.questionId, outcome: "answered", proposalId },
    })),
  ];
  const appended = await appendEvents(tx, sessionId, lastSeq, drafts);
  await rebuildProjections(tx, sessionId);
  return {
    ok: true,
    recorded: "now",
    proposalId,
    seq: appended[placed.length]?.seq ?? lastSeq,
    answered: check.answers.map((question) => question.questionId),
    lastSeq: appended.at(-1)?.seq ?? lastSeq,
  };
}

/** `proposal.created` v2's payload for the superseding proposal. */
function proposalPayload(proposalId: string, proposal: CorrectedProposal): Record<string, unknown> {
  return {
    proposalId,
    type: proposal.type,
    target: proposal.target,
    fields: proposal.fields,
    riskFlags: proposal.riskFlags,
    supersedes: proposal.supersedes,
    linker: proposal.linker,
  };
}

export type FollowupSkipOutcome =
  | { readonly ok: true; readonly recorded: "now" | "before"; readonly lastSeq: number }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "not_sealed" | "refused";
      readonly refusal?: CorrectionRefusal;
      readonly detail?: string;
    };

/**
 * The web Worker's skip of a follow-up question, under the same lock and seal rules: a question
 * already skipped is a resend (`before`), and one a correction answered is refused.
 */
export async function writeFollowupSkip<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  questionId: string,
  options: { readonly now: Date; readonly newId: () => string },
): Promise<FollowupSkipOutcome> {
  if (!isStoredUuid(sessionId)) return { ok: false, reason: "not_found" };
  await lockSession(tx, sessionId);
  const lastSeq = await lastSeqInWorkspace(tx, sessionId);
  if (lastSeq === undefined) return { ok: false, reason: "not_found" };
  const log = await readEvents(tx, sessionId);
  if (!log.some((event) => event.type === "session.sealed")) {
    return { ok: false, reason: "not_sealed" };
  }
  const { proposals } = replay(log, defaultProjections);
  const skipped = proposals
    .flatMap((proposal) => proposal.followups)
    .find((followup) => followup.questionId === questionId && followup.status === "skipped");
  if (skipped) return { ok: true, recorded: "before", lastSeq };
  const check = checkFollowupSkip(proposals, questionId);
  if (!check.ok) {
    return { ok: false, reason: "refused", refusal: check.reason, detail: check.detail };
  }
  const appended = await appendEvents(tx, sessionId, lastSeq, [
    {
      id: options.newId(),
      ts: options.now.toISOString(),
      type: "followup.closed",
      schemaVersion: 1,
      payload: { questionId, outcome: "skipped", proposalId: null },
    },
  ]);
  await rebuildProjections(tx, sessionId);
  return { ok: true, recorded: "now", lastSeq: appended.at(-1)?.seq ?? lastSeq };
}
