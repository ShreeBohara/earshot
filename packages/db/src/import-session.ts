// Sample sessions (Phase 5 spec decision 17, WP3 step 7): loads a sealed session log from JSONL
// into the transaction's workspace, so zero-setup development and the end-to-end tests have an
// inbox to review without running a debrief. Settings → Data's "Load sample debriefs" calls it.
//
// Every id in the log is replaced by one derived from the workspace and the original id, so the
// same file loads into any number of workspaces (proposal and utterance ids are unique across
// them) and loading it twice into one workspace finds the first copy and adds nothing.
import {
  defaultProjections,
  type EventDraft,
  type EventEnvelope,
  fromJsonl,
  NO_EVENTS,
  replay,
} from "@earshot/events";
import { like, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { DEMO_CRM_EXTERNAL_ID_PREFIX } from "./demo-crm";
import { appendEvents } from "./event-store";
import { rebuildProjections } from "./projections";
import { crmEntities, sessions } from "./schema";
import { currentTenant } from "./tenant";

export interface ImportSessionOptions {
  /**
   * Point records named by the demo CRM's dataset ids (`co_011`, `ct_045`, `deal_028`) at the
   * workspace's own rows for them, when the demo CRM is loaded. Ids it doesn't hold stay as they
   * are, and their proposals simply link to nothing in the mirror.
   */
  readonly mapDemoIds?: boolean;
  /** The seal's time, when the log doesn't end in one. Defaults to now. */
  readonly now?: Date;
}

export interface ImportedSession {
  /** The session's id in this workspace. */
  readonly sessionId: string;
  /** False when the workspace already had this sample: nothing was written. */
  readonly created: boolean;
  /** Events in the stored log, the import's own end and seal included. */
  readonly events: number;
  readonly proposals: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fields that hold a CRM record's id, which `mapDemoIds` rewrites. */
const ENTITY_ID_KEYS = new Set(["entityId", "targetEntityId", "relinked"]);

/**
 * A UUID (version 8, RFC 9562's custom version) from SHA-256 of the workspace and the original id:
 * the same in every load into one workspace, different in every other workspace.
 */
async function derivedId(workspaceId: string, original: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`earshot.import.v1:${workspaceId}:${original.toLowerCase()}`),
    ),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // the RFC variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every UUID-shaped string in `value`, keys excluded. */
function collectUuids(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (UUID.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUuids(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectUuids(item, into);
  }
}

/**
 * A copy of `value` with every string in `ids` replaced, and, with `entities`, every record id in
 * an entity-id field (or an `offered` list) that the map names.
 */
function rewrite(
  value: unknown,
  ids: ReadonlyMap<string, string>,
  entities: ReadonlyMap<string, string> | null,
  key?: string,
): unknown {
  if (typeof value === "string") {
    const record = entities && key !== undefined && ENTITY_ID_KEYS.has(key) && entities.get(value);
    if (record) return record;
    return ids.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    // An `offered` list holds record ids too.
    return value.map((item) => rewrite(item, ids, entities, key === "offered" ? "entityId" : key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, rewrite(item, ids, entities, name)]),
    );
  }
  return value;
}

/**
 * Imports a session log, given as JSONL, into the transaction's workspace as the transaction's
 * user's session, sealed. The log must replay (`fromJsonl` and `replay` check it before anything is
 * written). If it doesn't end, `session.ended` is added at its last event's time; if it isn't
 * sealed, `session.sealed { by: "import" }` is added. Then the projections are rebuilt, so the
 * session appears in the inbox like any other. A sample the workspace already holds is left as it
 * is (`created: false`).
 */
export async function importSessionLog<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  jsonl: string,
  options: ImportSessionOptions = {},
): Promise<ImportedSession> {
  const { userId, workspaceId } = await currentTenant(tx, "importSessionLog");
  const original = fromJsonl(jsonl);
  const projections = replay(original, defaultProjections);
  const started = projections.session;
  if (!started) throw new TypeError("importSessionLog: the log has no session.started");

  const found = new Set<string>();
  for (const event of original) {
    found.add(event.id);
    found.add(event.sessionId);
    collectUuids(event.payload, found);
  }
  const ids = new Map<string, string>();
  for (const id of found) ids.set(id, await derivedId(workspaceId, id));

  let entities: Map<string, string> | null = null;
  if (options.mapDemoIds) {
    const rows = await tx
      .select({ id: crmEntities.id, externalId: crmEntities.externalId })
      .from(crmEntities)
      .where(like(crmEntities.externalId, `${DEMO_CRM_EXTERNAL_ID_PREFIX}%`));
    entities = new Map(
      rows.map((row) => [row.externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length), row.id]),
    );
  }

  const sessionId = ids.get(started.sessionId) ?? started.sessionId;
  const inserted = await tx
    .insert(sessions)
    .values({
      id: sessionId,
      workspaceId,
      userId,
      mode: started.mode,
      engine: started.engine,
      providers: started.providers as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: sessions.id })
    .returning({ id: sessions.id });
  if (inserted.length === 0) {
    return {
      sessionId,
      created: false,
      events: original.length,
      proposals: projections.proposals.length,
    };
  }

  const drafts: EventDraft[] = original.map((event: EventEnvelope) => ({
    id: ids.get(event.id) ?? event.id,
    seq: event.seq,
    type: event.type,
    schemaVersion: event.schemaVersion,
    ts: event.ts,
    payload: rewrite(event.payload, ids, entities) as Record<string, unknown>,
  }));
  const now = (options.now ?? new Date()).toISOString();
  const last = original.at(-1);
  let nextSeq = (last?.seq ?? NO_EVENTS) + 1;
  const closing = async (type: string, payload: Record<string, unknown>) => {
    drafts.push({
      id: await derivedId(workspaceId, `${started.sessionId}:${type}`),
      seq: nextSeq,
      type,
      schemaVersion: 1,
      ts: now,
      payload,
    });
    nextSeq += 1;
  };
  if (started.status !== "ended") {
    await closing("session.ended", { endedAt: started.lastEventAt, costUsd: started.costUsd ?? 0 });
  }
  if (started.sealedAt === null) {
    await closing("session.sealed", { sealedAt: now, by: "import" });
  }
  await appendEvents(tx, sessionId, NO_EVENTS, drafts);
  const rebuilt = await rebuildProjections(tx, sessionId);
  return {
    sessionId,
    created: true,
    events: drafts.length,
    proposals: rebuilt.proposals.length,
  };
}
