// Reviews in Postgres (Phase 5 WP3, docs/adr/0032 and 0033):
//
// - `recordReviewAudit`: the audit rows for the review events a transaction just appended, and one
//   signed checkpoint, whoever appended them: the flush consumer for the socket's reviews
//   (`request: "flush"`), the web Worker for the inbox's (`request: "review"`).
// - `writeSessionReviews`: the web Worker's writes once a session is sealed, in one transaction:
//   the session's lock, a log that holds `session.sealed`, the writers' rules (`checkReviews`,
//   `checkSnooze`), the append, the projections, and the audit rows last.
// - `sealSessionLog` and `unsealedSessions`: the repair path, for sessions whose seal never came.
//
// Every function takes a transaction from `withTenant`, so row-level security confines it to one
// workspace, and audit rows name the transaction's user, as the `actor_insert` policy requires.
//
// The lock order, everywhere: the session's advisory lock first (`appendEvents` takes it), then the
// workspace's audit lock, which the audit trigger takes on the first audit insert and holds until
// commit. Audit rows are written after `rebuildProjections`, the transaction's last and slowest
// step but one, so the audit lock is held only for the inserts and the checkpoint's signature.

import {
  checkReviews,
  checkSnooze,
  defaultRegistry,
  type EventDraft,
  type EventEnvelope,
  NO_EVENTS,
  type ProposalReviewedEvent,
  type ProposalSnoozedEvent,
  type ProposalView,
  proposalsProjection,
  type ReviewRefusal,
  replay,
  sessionProjection,
  type TierOf,
  toJsonl,
} from "@earshot/events";
import type { AuditSigner } from "@earshot/keys/server";
import { tierOf as defaultTierOf } from "@earshot/understanding/tiers";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type TablesRelationalConfig,
} from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  type AuditCheckpoint,
  type AuditEntryInput,
  type RecordedAudit,
  recordAudit,
  writeCheckpoint,
} from "./audit-chain";
import {
  appendEvents,
  isStoredUuid,
  lastSeqInWorkspace,
  lockSession,
  readEvents,
} from "./event-store";
import { rebuildProjections } from "./projections";
import { sessions } from "./schema";

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/** `proposal.reviewed` v3's payload. */
export type ReviewPayload = ProposalReviewedEvent["payload"];
/** `proposal.snoozed` v1's payload. */
export type SnoozePayload = ProposalSnoozedEvent["payload"];

/** Review events need audit rows and a checkpoint, and there's no key to sign it with. */
export class AuditUnavailableError extends Error {
  override readonly name = "AuditUnavailableError";
}

/**
 * The audit action a review records: `proposal.approved`, `proposal.edited`,
 * `proposal.rejected`, `proposal.reopened`, or `proposal.auto_approved` for a policy's approval.
 */
export function reviewAuditAction(review: Pick<ReviewPayload, "decision" | "mode">): string {
  if (review.decision === "approved" && review.mode === "policy") return "proposal.auto_approved";
  return `proposal.${review.decision}`;
}

/**
 * SHA-256 of an event's line in `toJsonl`'s output, without its newline, in lowercase hex: the
 * canonical bytes of the event as stored, which tie an audit row to exactly one event. A verifier
 * hashes each line of an exported `.jsonl` file the same way.
 */
export async function eventSha256(event: EventEnvelope): Promise<string> {
  const line = toJsonl([event]).slice(0, -1);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(line));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The audit entries for the review events among `events`, in seq order (spec §4.5): the subject is
 * the proposal, and the detail names the session, the event (its id, seq, and hash), and how the
 * review was made. Snoozes and every other event get none: they approve nothing.
 */
export async function reviewAuditEntries(
  events: readonly EventEnvelope[],
): Promise<AuditEntryInput[]> {
  const entries: AuditEntryInput[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== "proposal.reviewed") continue;
    // Read at the latest version; hash as stored.
    const review = (defaultRegistry.toLatest(event) as ProposalReviewedEvent).payload;
    entries.push({
      action: reviewAuditAction(review),
      subjectType: "proposal",
      subjectId: review.proposalId,
      detail: {
        sessionId: event.sessionId,
        eventId: event.id,
        seq: event.seq,
        eventSha256: await eventSha256(event),
        reviewId: review.reviewId,
        mode: review.mode,
        batchId: review.batchId,
        policy: review.policy,
        undoes: review.undoes,
        auth: review.by?.auth ?? null,
        surface: review.surface,
        input: review.input,
      },
    });
  }
  return entries;
}

/** The audit rows one request wrote, and the checkpoint that signs them. */
export interface RecordedReviewAudit {
  readonly audit: RecordedAudit;
  readonly checkpoint: AuditCheckpoint;
}

/**
 * Records an audit row for each review event among `events`, which the transaction has just
 * appended, then one checkpoint signing the chain's new head (`request`: `flush` for a flush
 * message, `review` for a web request). Returns null, and writes nothing, when there are no review
 * events. Throws `AuditUnavailableError` before writing anything when there are and `signer` is
 * null: reviews never reach Postgres without their rows. Call it last in the transaction: the audit
 * lock it takes is held until commit.
 */
export async function recordReviewAudit<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  signer: AuditSigner | null,
  events: readonly EventEnvelope[],
  request: "review" | "flush",
  at?: Date,
): Promise<RecordedReviewAudit | null> {
  const entries = await reviewAuditEntries(events);
  if (entries.length === 0) return null;
  if (!signer) {
    throw new AuditUnavailableError(
      "reviews need an audit checkpoint, and EARSHOT_AUDIT_SIGNING_KEY isn't usable here",
    );
  }
  const audit = await recordAudit(tx, entries);
  const checkpoint = await writeCheckpoint(tx, signer, audit.head, request, at);
  return { audit, checkpoint };
}

// ─── The web Worker's writes after the seal ──────────────────────────────────────────────────────

/** One request's reviews and snoozes, complete: `by` and `syncEligibleAt` already filled. */
export interface SessionReviewRequest {
  readonly reviews: readonly ReviewPayload[];
  readonly snoozes: readonly SnoozePayload[];
}

/** One review or snooze of a request, and where it is in the log. */
export interface ReviewWrite {
  /** Its `reviewId` or `snoozeId`. */
  readonly id: string;
  readonly seq: number;
  /** `now` if this request appended it, `before` if the log already held it (a resend). */
  readonly recorded: "now" | "before";
}

export type SessionReviewOutcome =
  | {
      readonly ok: true;
      readonly reviews: readonly ReviewWrite[];
      readonly snoozes: readonly ReviewWrite[];
      /** The log's last seq after the request. */
      readonly lastSeq: number;
      /** The checkpoint signing this request's audit rows; null when it appended no review. */
      readonly checkpoint: AuditCheckpoint | null;
    }
  | {
      readonly ok: false;
      /**
       * - `not_found`: the session isn't in the workspace.
       * - `not_sealed`: Postgres doesn't hold `session.sealed`, so `SessionDO` may still write.
       * - `refused`: a review or a snooze broke a writer's rule (`refusal` says which).
       * - `audit_unavailable`: reviews need a checkpoint, and there's no signing key.
       */
      readonly reason: "not_found" | "not_sealed" | "refused" | "audit_unavailable";
      /** For `refused`: which item, where in its list, and why. */
      readonly kind?: "review" | "snooze";
      readonly index?: number;
      readonly refusal?: ReviewRefusal;
      readonly detail?: string;
    };

export interface SessionReviewOptions {
  /** Signs the checkpoint; null when the deployment has no usable key (reviews then fail closed). */
  readonly signer: AuditSigner | null;
  /** The writer's clock: each appended event's `ts`. */
  readonly now: Date;
  /** Event ids: UUIDv7 in the app. */
  readonly newId: () => string;
  /**
   * The likely-edit tier the rules read for "accept all": `tierOf` from
   * `@earshot/understanding/tiers` (Phase 5 spec §4.4) unless a test passes another.
   */
  readonly tierOf?: TierOf;
}

/**
 * The web Worker's review write (spec §4.3), in the caller's `withTenant` transaction:
 *
 * 1. Takes the session's advisory lock, the one `appendEvents` takes.
 * 2. Reads the log. Without `session.sealed` it answers `not_sealed` and writes nothing, even if
 *    the session has ended: until Postgres holds the seal, `SessionDO` may still append.
 * 3. Folds it, skips every review and snooze whose id the log already holds (a resend; one under
 *    an id the log holds for another proposal is refused), and checks the rest with the writers'
 *    rules, as the client sent them (`from: "client"`).
 * 4. Appends them after the log's last seq: reviews, then snoozes, in request order.
 * 5. Rebuilds the projections.
 * 6. Writes an audit row per review it appended and one checkpoint (`request: "review"`), last.
 *
 * A proposal may appear once per request, across reviews and snoozes.
 */
export async function writeSessionReviews<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  request: SessionReviewRequest,
  options: SessionReviewOptions,
): Promise<SessionReviewOutcome> {
  if (!isStoredUuid(sessionId)) return { ok: false, reason: "not_found" };
  await lockSession(tx, sessionId);
  const lastSeq = await lastSeqInWorkspace(tx, sessionId);
  if (lastSeq === undefined) return { ok: false, reason: "not_found" };
  const log = await readEvents(tx, sessionId);
  if (!log.some((event) => event.type === "session.sealed")) {
    return { ok: false, reason: "not_sealed" };
  }

  const refused = (
    kind: "review" | "snooze",
    index: number,
    refusal: ReviewRefusal,
    detail: string,
  ): SessionReviewOutcome => ({ ok: false, reason: "refused", kind, index, refusal, detail });

  const named = new Set<string>();
  for (const [index, review] of request.reviews.entries()) {
    if (named.has(review.proposalId)) {
      return refused("review", index, "malformed", "a proposal appears twice in the request");
    }
    named.add(review.proposalId);
  }
  for (const [index, snooze] of request.snoozes.entries()) {
    if (named.has(snooze.proposalId)) {
      return refused("snooze", index, "malformed", "a proposal appears twice in the request");
    }
    named.add(snooze.proposalId);
  }
  // One id names one write. Two items sharing an id, even both new, would commit twice under it,
  // and the retry that idempotency promises would then be refused: across reviews and snoozes.
  const ids = new Set<string>();
  for (const [index, review] of request.reviews.entries()) {
    if (ids.has(review.reviewId)) {
      return refused("review", index, "malformed", "a write id appears twice in the request");
    }
    ids.add(review.reviewId);
  }
  for (const [index, snooze] of request.snoozes.entries()) {
    if (ids.has(snooze.snoozeId)) {
      return refused("snooze", index, "malformed", "a write id appears twice in the request");
    }
    ids.add(snooze.snoozeId);
  }

  const { proposals } = replay(log, { proposals: proposalsProjection });
  const recorded = recordedWrites(log);
  const reviews: ReviewWrite[] = [];
  const snoozes: ReviewWrite[] = [];
  const newReviews: { index: number; payload: ReviewPayload }[] = [];
  const newSnoozes: { index: number; payload: SnoozePayload }[] = [];
  for (const [index, review] of request.reviews.entries()) {
    const prior = recorded.get(review.reviewId);
    if (prior === undefined) {
      newReviews.push({ index, payload: review });
    } else if (prior.kind !== "review" || prior.proposalId !== review.proposalId) {
      return refused("review", index, "malformed", "the review id is already used for another");
    } else {
      reviews[index] = { id: review.reviewId, seq: prior.seq, recorded: "before" };
    }
  }
  for (const [index, snooze] of request.snoozes.entries()) {
    const prior = recorded.get(snooze.snoozeId);
    if (prior === undefined) {
      newSnoozes.push({ index, payload: snooze });
    } else if (prior.kind !== "snooze" || prior.proposalId !== snooze.proposalId) {
      return refused("snooze", index, "malformed", "the snooze id is already used for another");
    } else {
      snoozes[index] = { id: snooze.snoozeId, seq: prior.seq, recorded: "before" };
    }
  }

  const tierOf = options.tierOf ?? defaultTierOf;
  const reviewCheck = checkReviews(
    proposals,
    newReviews.map((item) => item.payload),
    { tierOf, from: "client" },
  );
  if (!reviewCheck.ok) {
    const index = newReviews[reviewCheck.index]?.index ?? reviewCheck.index;
    return refused("review", index, reviewCheck.reason, reviewCheck.detail);
  }
  for (const item of newSnoozes) {
    const check = checkSnooze(proposals, item.payload);
    if (!check.ok) return refused("snooze", item.index, check.reason, check.detail);
  }

  if (newReviews.length === 0 && newSnoozes.length === 0) {
    return { ok: true, reviews, snoozes, lastSeq, checkpoint: null };
  }
  if (newReviews.length > 0 && !options.signer) return { ok: false, reason: "audit_unavailable" };

  const ts = options.now.toISOString();
  const drafts: EventDraft[] = [
    ...newReviews.map((item) => ({
      id: options.newId(),
      ts,
      type: "proposal.reviewed",
      schemaVersion: 3,
      payload: { ...item.payload } as Record<string, unknown>,
    })),
    ...newSnoozes.map((item) => ({
      id: options.newId(),
      ts,
      type: "proposal.snoozed",
      schemaVersion: 1,
      payload: { ...item.payload } as Record<string, unknown>,
    })),
  ];
  const appended = await appendEvents(tx, sessionId, lastSeq, drafts);
  for (const [position, item] of newReviews.entries()) {
    const event = appended[position];
    if (event) reviews[item.index] = { id: item.payload.reviewId, seq: event.seq, recorded: "now" };
  }
  for (const [position, item] of newSnoozes.entries()) {
    const event = appended[newReviews.length + position];
    if (event) snoozes[item.index] = { id: item.payload.snoozeId, seq: event.seq, recorded: "now" };
  }
  await rebuildProjections(tx, sessionId);
  const audit = await recordReviewAudit(tx, options.signer, appended, "review", options.now);
  return {
    ok: true,
    reviews,
    snoozes,
    lastSeq: appended.at(-1)?.seq ?? lastSeq,
    checkpoint: audit?.checkpoint ?? null,
  };
}

/** Every review id and snooze id in a log, with its seq and proposal. */
function recordedWrites(
  log: readonly EventEnvelope[],
): Map<string, { kind: "review" | "snooze"; seq: number; proposalId: string }> {
  const writes = new Map<string, { kind: "review" | "snooze"; seq: number; proposalId: string }>();
  for (const event of log) {
    if (event.type === "proposal.reviewed") {
      // A v1 review's id is its event's id once upcast, so it can be named too.
      const review = (defaultRegistry.toLatest(event) as ProposalReviewedEvent).payload;
      writes.set(review.reviewId, {
        kind: "review",
        seq: event.seq,
        proposalId: review.proposalId,
      });
    } else if (event.type === "proposal.snoozed") {
      const snooze = (defaultRegistry.toLatest(event) as ProposalSnoozedEvent).payload;
      writes.set(snooze.snoozeId, {
        kind: "snooze",
        seq: event.seq,
        proposalId: snooze.proposalId,
      });
    }
  }
  return writes;
}

/** The session's proposals as its Postgres log folds them, for the inbox and tests. */
export async function sessionProposals<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: Tx<TQueryResult, TFullSchema, TSchema>, sessionId: string): Promise<ProposalView[]> {
  return [...replay(await readEvents(tx, sessionId), { proposals: proposalsProjection }).proposals];
}

// ─── The repair path ─────────────────────────────────────────────────────────────────────────────

/**
 * What `sealSessionLog` did: sealed the log now; found it sealed already; found no events to seal;
 * or found no such session in the workspace.
 */
export type SealRepair = "sealed" | "already_sealed" | "empty" | "not_found";

/** Rounds to a billionth of a dollar, as SessionDO's meter does. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

/**
 * Seals a session's log from the web Worker (spec §4.3, the repair path), for a session whose
 * `SessionDO` answered `gone`: it holds nothing, so it will never write again, and Postgres's copy
 * is all there is. Under the session's lock: if the log never ended, `session.ended` first, at the
 * last event's time, with the usage it recorded as its cost; then `session.sealed { by: "web" }`;
 * then the projections. A log that's already sealed, or empty, is left alone.
 */
export async function sealSessionLog<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  options: { readonly now: Date; readonly newId: () => string },
): Promise<SealRepair> {
  if (!isStoredUuid(sessionId)) return "not_found";
  await lockSession(tx, sessionId);
  const lastSeq = await lastSeqInWorkspace(tx, sessionId);
  if (lastSeq === undefined) return "not_found";
  if (lastSeq === NO_EVENTS) return "empty";
  const log = await readEvents(tx, sessionId);
  const { session } = replay(log, { session: sessionProjection });
  if (!session) return "empty";
  if (session.sealedAt !== null) return "already_sealed";

  const ts = options.now.toISOString();
  const drafts: EventDraft[] = [];
  if (session.status !== "ended") {
    const costUsd = roundUsd(
      log.reduce(
        (sum, event) =>
          event.type === "usage.recorded" && typeof event.payload.costUsd === "number"
            ? sum + event.payload.costUsd
            : sum,
        0,
      ),
    );
    drafts.push({
      id: options.newId(),
      ts,
      type: "session.ended",
      schemaVersion: 1,
      payload: { endedAt: session.lastEventAt, costUsd },
    });
  }
  drafts.push({
    id: options.newId(),
    ts,
    type: "session.sealed",
    schemaVersion: 1,
    payload: { sealedAt: ts, by: "web" },
  });
  await appendEvents(tx, sessionId, lastSeq, drafts);
  await rebuildProjections(tx, sessionId);
  return "sealed";
}

/**
 * The workspace's sessions the repair path asks `SessionDO` about, oldest first, at most `limit`:
 * those with events and no seal that ended before `endedBefore`, or that never ended in Postgres
 * and started before `startedBefore` (an object lost before it could end its session). Only the
 * transaction's user's own sessions.
 */
export async function unsealedSessions<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  options: { readonly endedBefore: Date; readonly startedBefore: Date; readonly limit: number },
): Promise<string[]> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, sql`current_setting('app.user_id', true)`),
        isNull(sessions.sealedAt),
        or(
          and(isNotNull(sessions.endedAt), lt(sessions.endedAt, options.endedBefore)),
          and(isNull(sessions.endedAt), lt(sessions.startedAt, options.startedBefore)),
        ),
        // Spelled out: Drizzle leaves columns unqualified in a one-table select, and inside the
        // subquery an unqualified `id` would be the event's.
        sql`exists (select 1 from "session_events" where "session_events"."session_id" = "sessions"."id")`,
      ),
    )
    .orderBy(asc(sql`coalesce(${sessions.endedAt}, ${sessions.startedAt})`), asc(sessions.id))
    .limit(options.limit);
  return rows.map((row) => row.id);
}
