// The inbox's loader (Phase 5 spec WP5 step 1): the viewer's latest debriefs with proposals, under
// `withTenant`, so row-level security confines every read to the workspace. For each debrief: its
// proposals (the `proposals` rows `rebuildProjections` writes, one `ProposalView` each), the words
// their quotes come from, the records they name with each one's account and current values, and
// whether it's sealed. The page and `GET /api/inbox` both call it, after the repair path
// (lib/reviews/repair.ts) has sealed what it can.
//
// Phase 5 WP12 adds what the CRM's mirror says at review time (`InboxProposal.crm`, ./crm.ts): from
// the mirror's history, each update's fields whose CRM value moved since the proposal (`base`, the
// value then, by `valueAt`'s rule), and for new records still open, a record the linker links their
// words to now that reached the CRM after the rep spoke (./relink.ts). Also which records are demo
// records, and whether the workspace's mirror is the demo CRM, for the demo controls.
import type {
  FieldValue,
  ProposalFieldV2,
  ProposalTypeV2,
  RiskFlagV2,
  TargetV2,
  WitnessConflict,
} from "@earshot/core";
import {
  DEMO_CRM_EXTERNAL_ID_PREFIX,
  type FieldRef,
  fieldKey,
  isDemoCrmWorkspace,
  readFieldHistory,
  schema,
  valueFromHistory,
} from "@earshot/db";
import type { ProposalStatus, ReviewView, SessionRecap } from "@earshot/events";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { TenantTx } from "../auth/viewer";
import { recapUtteranceIds } from "../recap/view";
import { loadCrmEntities } from "../voice/crm-rows";
import { UPDATE_FIELDS } from "./crm";
import { canRelink, earlierLinks, mirrorIndex, relinkTarget } from "./relink";
import type {
  InboxCrm,
  InboxData,
  InboxEntity,
  InboxProposal,
  InboxReview,
  InboxSession,
} from "./types";

/** How many debriefs one load reads (target); "Load older" reads as many again. */
export const INBOX_PAGE_SIZE = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** "Load older"'s cursor: the last debrief shown, by start time and id. */
export function olderCursor(session: Pick<InboxSession, "startedAt" | "sessionId">): string {
  return `${session.startedAt}_${session.sessionId}`;
}

/** A cursor back as its parts, or null for anything else. */
export function parseOlderCursor(
  cursor: string | null | undefined,
): { startedAt: Date; sessionId: string } | null {
  if (typeof cursor !== "string" || cursor.length > 80) return null;
  const separator = cursor.indexOf("_");
  if (separator < 0) return null;
  const startedAt = cursor.slice(0, separator);
  const sessionId = cursor.slice(separator + 1);
  if (!ISO.test(startedAt) || !UUID.test(sessionId)) return null;
  const date = new Date(startedAt);
  return Number.isNaN(date.getTime())
    ? null
    : { startedAt: date, sessionId: sessionId.toLowerCase() };
}

/** The values an update's fields read as "before", by record kind. */
const VALUE_KEYS: Readonly<Record<string, readonly string[]>> = {
  deal: ["stage", "amount", "closeDate"],
  contact: ["title", "email", "phone"],
};
const ALL_VALUE_KEYS = [...new Set(Object.values(VALUE_KEYS).flat())];

/** A flag as the `risk_flags` column spells it, `kind` or `kind:field`, back as `RiskFlagV2`. */
function parseFlag(text: string): RiskFlagV2 {
  const separator = text.indexOf(":");
  if (separator < 0) return { kind: text as RiskFlagV2["kind"] };
  return {
    kind: text.slice(0, separator) as RiskFlagV2["kind"],
    field: text.slice(separator + 1),
  };
}

/** A row from before Phase 4 has no `target`: a link to its record, or none. */
function fallbackTarget(entityId: string | null): TargetV2 {
  return {
    decision: entityId === null ? "none" : "linked",
    entityId,
    kind: null,
    basis: null,
    p: null,
    mention: null,
    company: null,
    candidates: entityId === null ? [] : [{ entityId, p: 1 }],
  };
}

type ProposalRow = typeof schema.proposals.$inferSelect;

/** The parts of the latest review the inbox reads; null for a row whose review has no id yet. */
function reviewOf(row: ProposalRow): InboxReview | null {
  const stored = row.review as Partial<Omit<ReviewView, "seq" | "ts">> | null;
  if (!stored || typeof stored.reviewId !== "string" || stored.decision === undefined) return null;
  return {
    reviewId: stored.reviewId,
    decision: stored.decision,
    target: stored.target ?? null,
    mode: stored.mode ?? "single",
    batchId: stored.batchId ?? null,
    policy: stored.policy ?? null,
    undoes: stored.undoes ?? null,
    syncEligibleAt: stored.syncEligibleAt ?? null,
    ts: (row.reviewedAt ?? row.updatedAt).toISOString(),
  };
}

/**
 * The `recap` column as the inbox holds it (migration 0015): `rebuildProjections` writes it from a
 * validated `recap.created`, so only its shape is checked here; anything else is no recap.
 */
function recapOf(value: unknown): SessionRecap | null {
  if (value === null || typeof value !== "object") return null;
  const recap = value as Partial<SessionRecap>;
  const shaped =
    typeof recap.outcome === "string" &&
    Array.isArray(recap.sentences) &&
    typeof recap.dropped === "number";
  return shaped ? (recap as SessionRecap) : null;
}

/** A `proposals` row as the inbox holds it: the `ProposalView` it was written from. */
export function proposalFromRow(row: ProposalRow): InboxProposal {
  const target = (row.target as TargetV2 | null) ?? fallbackTarget(row.targetEntityId);
  return {
    proposalId: row.id,
    type: row.type as ProposalTypeV2,
    targetEntityId: target.entityId,
    target,
    status: row.status as ProposalStatus,
    fields: row.fields as Record<string, ProposalFieldV2>,
    riskFlags: row.riskFlags.map(parseFlag),
    conflicts: row.conflicts as unknown as WitnessConflict[],
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    seq: row.seq ?? 0,
    ts: row.createdAt.toISOString(),
    review: reviewOf(row),
  };
}

/** Every utterance and record id the proposals point at. */
function referenced(sessions: readonly InboxSession[]): {
  utterances: Set<string>;
  entities: Set<string>;
} {
  const utterances = new Set<string>();
  const entities = new Set<string>();
  const entity = (id: string | null | undefined) => {
    if (id && UUID.test(id)) entities.add(id.toLowerCase());
  };
  const utterance = (id: string | undefined) => {
    if (id && UUID.test(id)) utterances.add(id.toLowerCase());
  };
  for (const session of sessions) {
    entity(session.focusEntityId);
    // The words each recap sentence and lens field quotes (Phase 5 WP10).
    if (session.recap) for (const id of recapUtteranceIds(session.recap)) utterance(id);
    for (const proposal of session.proposals) {
      const { target } = proposal;
      entity(target.entityId);
      entity(target.company?.entityId);
      for (const candidate of target.candidates) entity(candidate.entityId);
      entity(proposal.review?.target?.entityId);
      utterance(target.mention?.evidence.utteranceId);
      utterance(target.company?.evidence.utteranceId);
      for (const field of Object.values(proposal.fields)) utterance(field.evidence.utteranceId);
      for (const conflict of proposal.conflicts) utterance(conflict.biased.evidence.utteranceId);
    }
  }
  return { utterances, entities };
}

/** A record's id in its source, which its contacts and deals name as `companyId`. */
function sourceIdOf(row: { connectionId: string | null; externalId: string }): string {
  return row.connectionId === null && row.externalId.startsWith(DEMO_CRM_EXTERNAL_ID_PREFIX)
    ? row.externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length)
    : row.externalId;
}

type EntityRow = {
  id: string;
  kind: string;
  name: string;
  connectionId: string | null;
  externalId: string;
  companyId: string | null;
  values: Record<string, unknown> | null;
};

/** The records the cards name, each with its account and the values an update reads. */
async function loadEntities(
  tx: TenantTx,
  workspaceId: string,
  ids: ReadonlySet<string>,
): Promise<Record<string, InboxEntity>> {
  if (ids.size === 0) return {};
  const { crmEntities } = schema;
  const columns = {
    id: crmEntities.id,
    kind: crmEntities.kind,
    name: crmEntities.name,
    connectionId: crmEntities.connectionId,
    externalId: crmEntities.externalId,
    companyId: sql<string | null>`${crmEntities.properties} ->> 'companyId'`,
    // Only the values an update reads, never the whole row: a real CRM's properties are large.
    values: sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(${sql.join(
      ALL_VALUE_KEYS.map((key) => sql`${key}::text, ${crmEntities.properties} -> ${key}::text`),
      sql`, `,
    )}))`,
  };
  const inWorkspace = eq(crmEntities.workspaceId, workspaceId);
  const rows: EntityRow[] = await tx
    .select(columns)
    .from(crmEntities)
    .where(and(inWorkspace, inArray(crmEntities.id, [...ids])));

  // Each contact's and deal's company: the company on the same connection whose source id is its
  // `companyId`, as the session routes resolve parents (lib/voice/entities.ts).
  const companyIds = [
    ...new Set(
      rows.flatMap((row) => (row.kind !== "company" && row.companyId ? [row.companyId] : [])),
    ),
  ];
  const companies: EntityRow[] =
    companyIds.length === 0
      ? []
      : await tx
          .select(columns)
          .from(crmEntities)
          .where(
            and(
              inWorkspace,
              eq(crmEntities.kind, "company"),
              inArray(crmEntities.externalId, [
                ...companyIds,
                ...companyIds.map((id) => `${DEMO_CRM_EXTERNAL_ID_PREFIX}${id}`),
              ]),
            ),
          );
  const companyKey = (connectionId: string | null, sourceId: string) =>
    `${connectionId ?? ""}\u0000${sourceId}`;
  const companyBySource = new Map(
    [...rows, ...companies]
      .filter((row) => row.kind === "company")
      .map((row) => [companyKey(row.connectionId, sourceIdOf(row)), row.id]),
  );

  const entities: Record<string, InboxEntity> = {};
  for (const row of [...rows, ...companies]) {
    if (row.kind !== "company" && row.kind !== "contact" && row.kind !== "deal") continue;
    const accountId =
      row.kind === "company"
        ? row.id
        : row.companyId
          ? (companyBySource.get(companyKey(row.connectionId, row.companyId)) ?? null)
          : null;
    const values: Record<string, FieldValue> = {};
    for (const key of VALUE_KEYS[row.kind] ?? []) {
      const value = row.values?.[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values[key] = value;
      }
    }
    const demo =
      row.connectionId === null && row.externalId.startsWith(DEMO_CRM_EXTERNAL_ID_PREFIX);
    entities[row.id] = { id: row.id, kind: row.kind, name: row.name, accountId, values, demo };
  }
  return entities;
}

/**
 * The re-link offers (spec WP12 step 5), by proposal id: for each new-record proposal still open,
 * the record the linker links its words to now, over the mirror, with its session's focus account
 * and earlier links, when that record's arrival is in the mirror's history after the proposal was
 * made (its name was null then). The mirror is read and indexed once per load, and only when some
 * record arrived after the oldest such proposal, which is rare: most loads add one small query.
 */
async function relinkOffers(
  tx: TenantTx,
  workspaceId: string,
  sessions: readonly InboxSession[],
): Promise<Map<string, string>> {
  const offers = new Map<string, string>();
  const candidates = sessions.flatMap((session) =>
    session.proposals.filter(canRelink).map((proposal) => ({ session, proposal })),
  );
  if (candidates.length === 0) return offers;
  const since = new Date(Math.min(...candidates.map(({ proposal }) => Date.parse(proposal.ts))));
  const { crmEntityChanges } = schema;
  // A record's arrival is its name's change from null (docs/adr/0008).
  const [arrival] = await tx
    .select({ id: crmEntityChanges.id })
    .from(crmEntityChanges)
    .where(
      and(
        eq(crmEntityChanges.workspaceId, workspaceId),
        eq(crmEntityChanges.field, "name"),
        isNull(crmEntityChanges.old),
        gt(crmEntityChanges.changedAt, since),
      ),
    )
    .limit(1);
  if (!arrival) return offers;

  const rows = await loadCrmEntities(tx, workspaceId, null);
  const nameOf = new Map(rows.map((row) => [row.id, row.name]));
  const index = mirrorIndex(rows);
  const linked = candidates.flatMap(({ session, proposal }) => {
    const entityId = relinkTarget(proposal, {
      index,
      focusEntityId: session.focusEntityId,
      recent: earlierLinks(proposal, session.proposals),
    });
    return entityId === null ? [] : [{ proposal, entityId }];
  });
  if (linked.length === 0) return offers;
  const names = await readFieldHistory(
    tx,
    [...new Set(linked.map(({ entityId }) => entityId))].map(
      (entityId): FieldRef => ({ entityId, field: "name" }),
    ),
  );
  for (const { proposal, entityId } of linked) {
    const history = names.get(fieldKey({ entityId, field: "name" }));
    const name = nameOf.get(entityId);
    if (!history || name === undefined) continue;
    // Offered only if it wasn't in the CRM when the rep spoke: "added to your CRM after you spoke".
    if (valueFromHistory(history, new Date(proposal.ts), name) === null) {
      offers.set(proposal.proposalId, entityId);
    }
  }
  return offers;
}

/**
 * Each update's fields whose CRM value moved since the proposal was made (spec WP12 step 2), by
 * proposal id: a deal's stage, amount, and close date, a linked contact's title, email, and phone.
 * The value then is `valueAt`'s rule over the mirror's history at the proposal's time; the value
 * now is the record's. One history query for every field of every debrief loaded.
 */
async function movedFields(
  tx: TenantTx,
  sessions: readonly InboxSession[],
  entities: Readonly<Record<string, InboxEntity>>,
): Promise<Map<string, InboxCrm["moved"]>> {
  const updates: { proposal: InboxProposal; entityId: string; fields: string[] }[] = [];
  for (const session of sessions) {
    for (const proposal of session.proposals) {
      const { target } = proposal;
      if (proposal.status === "superseded" || target.decision !== "linked") continue;
      if (target.entityId === null || !entities[target.entityId]) continue;
      const fields = (UPDATE_FIELDS[proposal.type] ?? []).filter((f) => f in proposal.fields);
      if (fields.length > 0) updates.push({ proposal, entityId: target.entityId, fields });
    }
  }
  const moved = new Map<string, InboxCrm["moved"]>();
  if (updates.length === 0) return moved;
  const history = await readFieldHistory(
    tx,
    updates.flatMap(({ entityId, fields }) => fields.map((field) => ({ entityId, field }))),
  );
  for (const { proposal, entityId, fields } of updates) {
    const changed: Record<string, { base: FieldValue; changedAt: string }> = {};
    for (const field of fields) {
      const changes = history.get(fieldKey({ entityId, field }));
      const last = changes?.at(-1);
      if (!changes || !last) continue;
      const current = entities[entityId]?.values[field] ?? null;
      const base = valueFromHistory(changes, new Date(proposal.ts), current);
      if (base !== current) changed[field] = { base, changedAt: last.changedAt.toISOString() };
    }
    if (Object.keys(changed).length > 0) moved.set(proposal.proposalId, changed);
  }
  return moved;
}

/**
 * The viewer's latest debriefs with proposals, newest first, at most `limit` (20, target), older
 * than `before` when "Load older" asks; each with its proposals in the order they were made, and
 * the words and records the cards need. Run inside the viewer's tenant transaction.
 */
export async function loadInbox(
  tx: TenantTx,
  viewer: { readonly userId: string; readonly workspaceId: string },
  options: { readonly now: Date; readonly before?: string | null; readonly limit?: number },
): Promise<InboxData> {
  const { proposals, sessions, utterances } = schema;
  const limit = options.limit ?? INBOX_PAGE_SIZE;
  const cursor = parseOlderCursor(options.before);
  const rows = await tx
    .select({
      sessionId: sessions.id,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      sealedAt: sessions.sealedAt,
      focusEntityId: sessions.focusEntityId,
      recap: sessions.recap,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, viewer.workspaceId),
        // Only the viewer's own: the review route refuses another member's debrief.
        eq(sessions.userId, viewer.userId),
        // Spelled out: inside the subquery an unqualified `id` would be the proposal's.
        sql`exists (select 1 from "proposals" where "proposals"."session_id" = "sessions"."id")`,
        cursor
          ? or(
              lt(sessions.startedAt, cursor.startedAt),
              and(eq(sessions.startedAt, cursor.startedAt), lt(sessions.id, cursor.sessionId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.sessionId);

  const proposalRows =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(proposals)
          .where(inArray(proposals.sessionId, ids))
          .orderBy(asc(proposals.seq), asc(proposals.id));
  const bySession = new Map<string, InboxProposal[]>();
  for (const row of proposalRows) {
    const list = bySession.get(row.sessionId);
    const proposal = proposalFromRow(row);
    if (list) list.push(proposal);
    else bySession.set(row.sessionId, [proposal]);
  }

  const loaded: InboxSession[] = page.map((row) => ({
    sessionId: row.sessionId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    sealedAt: row.sealedAt?.toISOString() ?? null,
    focusEntityId: row.focusEntityId,
    proposals: bySession.get(row.sessionId) ?? [],
    recap: recapOf(row.recap),
  }));

  const wanted = referenced(loaded);
  const quoteRows =
    wanted.utterances.size === 0
      ? []
      : await tx
          .select({ id: utterances.id, text: utterances.text })
          .from(utterances)
          .where(inArray(utterances.id, [...wanted.utterances]));
  const quotes: Record<string, string> = {};
  for (const row of quoteRows) quotes[row.id] = row.text;

  // What the CRM's mirror says now (WP12): the records offered on new-record cards are named on
  // their cards too, so they're read with the rest.
  const relinks = await relinkOffers(tx, viewer.workspaceId, loaded);
  for (const entityId of relinks.values()) wanted.entities.add(entityId);
  const entities = await loadEntities(tx, viewer.workspaceId, wanted.entities);
  const moved = await movedFields(tx, loaded, entities);
  const withCrm: InboxSession[] = loaded.map((session) => ({
    ...session,
    proposals: session.proposals.map((proposal) => {
      const changed = moved.get(proposal.proposalId);
      const relink = relinks.get(proposal.proposalId) ?? null;
      return changed || relink !== null
        ? { ...proposal, crm: { moved: changed ?? {}, relink } }
        : proposal;
    }),
  }));

  const last = loaded.at(-1);
  return {
    sessions: withCrm,
    entities,
    quotes,
    older: rows.length > limit && last ? olderCursor(last) : null,
    loadedAt: options.now.toISOString(),
    demoCrm: await isDemoCrmWorkspace(tx),
  };
}
