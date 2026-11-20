import {
  defaultProjections,
  type ProjectionStates,
  type ProposalView,
  type ReplayOptions,
  type ReviewView,
  replay,
  type SessionView,
  type UtteranceView,
} from "@earshot/events";
import {
  and,
  type Column,
  eq,
  inArray,
  notInArray,
  type SQL,
  sql,
  type TablesRelationalConfig,
} from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import {
  currentWorkspace,
  isStoredUuid,
  lastSeqInWorkspace,
  lockSession,
  readEvents,
  type TenantTransaction,
  timestamptz,
  UnknownSessionError,
} from "./event-store";
import { crmEntities, proposals, sessions, utterances } from "./schema";

/** What one session's log replays to with the default projections. */
export type SessionProjections = ProjectionStates<typeof defaultProjections>;

/**
 * Rebuilds one session's projections in Postgres from its log (docs/adr/0020). It replays the
 * session's events with the default projections, replaces the session's `utterances` and
 * `proposals` rows with the result, and updates the summary columns of its `sessions` row: mode,
 * engine, providers, start, end, and cost. Returns the replayed projections.
 *
 * Call it inside `withTenant`, alone or after `appendEvents` in the same transaction, so the
 * projections never lag the log. It takes the session's lock, as an append does, so appends and
 * rebuilds of one session don't interleave, and every value it writes comes from the events, so
 * running it again writes the same rows. A session that isn't in the workspace gives
 * `UnknownSessionError`, and a log that `replay` refuses gives replay's error; neither writes
 * anything.
 *
 * Two values are adjusted to fit the tables: a proposal's `target_entity_id` is null unless that
 * entity is in the workspace's CRM mirror (the same as when the entity is deleted later), and a
 * missing cost is stored as `cost_usd` 0, rounded like any cost to four decimal places. The
 * `target` column keeps the linker's decision as the events have it, entity id included.
 *
 * Phase 5's review fields (migration 0014, docs/adr/0032): each row holds its latest review whole
 * in `review` (the `ReviewView` without its seq and time, which `reviewed_seq` and `reviewed_at`
 * hold), with the fields the inbox and Phase 6 query by in columns of their own (`review_id`,
 * `review_mode`, `batch_id`, `policy_id`, `sync_eligible_at`), and its snooze and supersedes.
 * The status is the latest decision, `proposed` after a reopen, and `superseded` once a
 * correction replaces the proposal. The session's row gets `sealed_at` from `session.sealed`.
 * The rest of the session's row (its user, metrics, and focus account) isn't the log's to say.
 */
export async function rebuildProjections<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  sessionId: string,
  options: ReplayOptions = {},
): Promise<SessionProjections> {
  if (!isStoredUuid(sessionId)) throw new UnknownSessionError(sessionId);
  await lockSession(tx, sessionId);
  if ((await lastSeqInWorkspace(tx, sessionId)) === undefined) {
    throw new UnknownSessionError(sessionId);
  }

  const projections = replay(await readEvents(tx, sessionId), defaultProjections, options);
  await writeUtterances(tx, sessionId, projections.utterances);
  await writeProposals(tx, sessionId, projections.proposals);
  if (projections.session) await writeSessionSummary(tx, sessionId, projections.session);
  return projections;
}

/** Replaces the session's utterances. Nothing references them by key, so delete and insert. */
async function writeUtterances(
  tx: TenantTransaction,
  sessionId: string,
  views: readonly UtteranceView[],
): Promise<void> {
  await tx.delete(utterances).where(eq(utterances.sessionId, sessionId));
  if (views.length === 0) return;
  await tx.insert(utterances).values(
    views.map((view) => ({
      id: view.utteranceId,
      workspaceId: currentWorkspace,
      sessionId,
      seq: view.seq,
      ts: timestamptz(view.ts),
      witness: view.witness,
      text: view.text,
      words: view.words,
      confidence: view.confidence,
      startedMs: view.startMs,
      endedMs: view.endMs,
    })),
  );
}

/**
 * Replaces the session's proposals. `sync_jobs` rows reference proposals and would cascade away
 * with a delete, so proposals that are still in the log are updated in place, and only the rest
 * are deleted.
 */
async function writeProposals(
  tx: TenantTransaction,
  sessionId: string,
  views: readonly ProposalView[],
): Promise<void> {
  const ids = views.map((view) => view.proposalId);
  await tx
    .delete(proposals)
    .where(
      and(
        eq(proposals.sessionId, sessionId),
        ids.length > 0 ? notInArray(proposals.id, ids) : undefined,
      ),
    );
  if (views.length === 0) return;

  const mirrored = await mirroredEntities(tx, views);
  const written = await tx
    .insert(proposals)
    .values(views.map((view) => proposalRow(view, sessionId, mirrored)))
    .onConflictDoUpdate({
      target: proposals.id,
      set: {
        type: excluded(proposals.type),
        targetEntityId: excluded(proposals.targetEntityId),
        target: excluded(proposals.target),
        fields: excluded(proposals.fields),
        riskFlags: excluded(proposals.riskFlags),
        conflicts: excluded(proposals.conflicts),
        status: excluded(proposals.status),
        editDiff: excluded(proposals.editDiff),
        reviewerMs: excluded(proposals.reviewerMs),
        seq: excluded(proposals.seq),
        reviewedSeq: excluded(proposals.reviewedSeq),
        reviewedAt: excluded(proposals.reviewedAt),
        review: excluded(proposals.review),
        reviewId: excluded(proposals.reviewId),
        reviewMode: excluded(proposals.reviewMode),
        batchId: excluded(proposals.batchId),
        policyId: excluded(proposals.policyId),
        syncEligibleAt: excluded(proposals.syncEligibleAt),
        snoozedUntil: excluded(proposals.snoozedUntil),
        supersedes: excluded(proposals.supersedes),
        supersededBy: excluded(proposals.supersededBy),
        createdAt: excluded(proposals.createdAt),
        updatedAt: excluded(proposals.updatedAt),
      },
      // Update only this session's row. Another session's proposal with the same id is an
      // error to report, not a row to take over. (Qualified, since `excluded` has the column too.)
      setWhere: sql`${proposals}.${sql.identifier(proposals.sessionId.name)} = ${excluded(proposals.sessionId)}`,
    })
    .returning({ id: proposals.id });

  if (written.length < views.length) {
    const writtenIds = new Set(written.map((row) => row.id));
    const taken = ids.filter((id) => !writtenIds.has(id.toLowerCase()));
    throw new Error(
      `session ${sessionId}: proposal ${taken.join(", ")} belongs to another session`,
    );
  }
}

function proposalRow(view: ProposalView, sessionId: string, mirrored: ReadonlySet<string>) {
  const target = view.targetEntityId?.toLowerCase();
  const review = view.review;
  return {
    id: view.proposalId,
    workspaceId: currentWorkspace,
    sessionId,
    type: view.type,
    targetEntityId: target !== undefined && mirrored.has(target) ? target : null,
    target: view.target,
    fields: view.fields,
    // A flag on the target is `kind:target`, like a flag on any field.
    riskFlags: view.riskFlags.map(({ kind, field }) =>
      field === undefined ? kind : `${kind}:${field}`,
    ),
    conflicts: view.conflicts,
    status: view.status,
    editDiff: review?.editDiff ?? null,
    // The review clock's handling time: v1's `reviewerMs`, which upcasts to both of v2's times.
    reviewerMs: review?.timing.handlingMs ?? null,
    seq: view.seq,
    reviewedSeq: review?.seq ?? null,
    reviewedAt: review ? timestamptz(review.ts) : null,
    review: review ? storedReview(review) : null,
    reviewId: review?.reviewId ?? null,
    reviewMode: review?.mode ?? null,
    batchId: review?.batchId ?? null,
    policyId: review?.policy?.id ?? null,
    syncEligibleAt: review?.syncEligibleAt ? timestamptz(review.syncEligibleAt) : null,
    snoozedUntil: view.snoozedUntil === null ? null : timestamptz(view.snoozedUntil),
    supersedes: view.supersedes,
    supersededBy: view.supersededBy,
    createdAt: timestamptz(view.ts),
    updatedAt: timestamptz(review?.ts ?? view.ts),
  };
}

/** A review as the `review` column keeps it: every field but its seq and time. */
function storedReview(review: ReviewView): Record<string, unknown> {
  const { seq: _seq, ts: _ts, ...rest } = review;
  return rest;
}

/** The proposals' target entities that the workspace's CRM mirror has, as stored ids. */
async function mirroredEntities(
  tx: TenantTransaction,
  views: readonly ProposalView[],
): Promise<Set<string>> {
  const targets = views
    .map((view) => view.targetEntityId?.toLowerCase())
    .filter((id) => isStoredUuid(id));
  if (targets.length === 0) return new Set();
  const rows = await tx
    .select({ id: crmEntities.id })
    .from(crmEntities)
    .where(inArray(crmEntities.id, [...new Set(targets)]));
  return new Set(rows.map((row) => row.id));
}

/** The summary columns of the session's row that a `SessionView` fills. */
async function writeSessionSummary(
  tx: TenantTransaction,
  sessionId: string,
  view: SessionView,
): Promise<void> {
  const updated = await tx
    .update(sessions)
    .set({
      mode: view.mode,
      engine: view.engine,
      providers: view.providers,
      startedAt: timestamptz(view.startedAt),
      endedAt: view.endedAt === null ? null : timestamptz(view.endedAt),
      sealedAt: view.sealedAt === null ? null : timestamptz(view.sealedAt),
      costUsd: String(view.costUsd ?? 0),
    })
    .where(eq(sessions.id, sessionId))
    .returning({ id: sessions.id });
  if (updated.length === 0) {
    throw new Error(
      `session ${sessionId}: row-level security let this transaction read the session, but not update it`,
    );
  }
}

/** The value the insert proposed for `column`, in `ON CONFLICT ... DO UPDATE`. */
function excluded(column: Column): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}
