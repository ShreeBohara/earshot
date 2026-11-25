// The CRM adapter SDK's types (Phase 6 spec §4.2, decisions 7, 8, 12, and 15; docs/adr/0040). WP1
// fixes the shapes; WP2 builds their behavior, the reference CRM, and the conformance suite on them.
// An adapter turns an approval into ordered writes with a pure `plan()`, renders them for the dry
// run with a pure `requests()`, and does its I/O only through the `fetch` its connection supplies,
// which waits for the connection's limiter and adds the credential: so an adapter imports nothing
// from a Worker, holds no token, and runs in the edge Worker, the web Worker, and Node alike.
import type { CrmMapping, CrmObject, CrmProvider, ExternalRef, FieldValue } from "@earshot/core";
import type { ProposalView, ReviewView } from "@earshot/events";

/**
 * How a CRM keeps a write to one (decision 7): it upserts by the write's marker (`upsert`), takes a
 * record id the client chose, which a retry collides with (`client_id`), or the adapter reads the
 * marker back, with a read that's consistent right away, before it creates (`readback`).
 */
export type IdempotencyMode = "upsert" | "client_id" | "readback";

/** What a CRM can do, as its adapter declares it: plans, the outbox, and the mirror read it. */
export interface Capabilities {
  /** What the CRM can hold. */
  readonly objects: Readonly<Record<CrmObject, boolean>>;
  /** How a write is kept to one: for records (companies, contacts, deals), and activities. */
  readonly idempotency: {
    readonly records: IdempotencyMode;
    readonly activities: IdempotencyMode;
  };
  /** Associations set on create (`inline`), or by later calls (`separate`). */
  readonly associations: "inline" | "separate";
  /** How the mirror polls: records changed since a time, or a full pass. */
  readonly changes: "modified_since" | "full_scan";
  readonly webhooks: boolean;
  /** Whether a task can be assigned to an owner. */
  readonly owners: boolean;
  /** Whose name a write carries in the CRM: the rep's (`user`), or the key's (`key`). */
  readonly attribution: "user" | "key";
}

/** A record of Earshot's mirror (`crm_entities`) that a plan writes to or links to. */
export interface MirrorRef {
  /** The mirror row's id: what proposals and reviews name. */
  readonly entityId: string;
  /** The record in the CRM: what it is, its id there, and its link. */
  readonly ref: ExternalRef;
  /** Its name, as the mirror holds it. */
  readonly name: string;
}

/** A deal stage, as the CRM's schema lists it. */
export interface CrmStage {
  readonly stageId: string;
  /** Null where the CRM has no pipelines. */
  readonly pipelineId: string | null;
  readonly label: string;
}

/** A CRM user a task can be assigned to. */
export interface CrmOwner {
  readonly ownerId: string;
  /** What the mapping matches a rep by. */
  readonly email: string | null;
  readonly name: string | null;
}

/** The type an association between two kinds of record takes, in the CRM's own terms. */
export interface CrmAssociationType {
  readonly from: CrmObject;
  readonly to: CrmObject;
  /** HubSpot's numbers (a note to a deal is 214), or a CRM's own name for the link. */
  readonly type: string | number;
}

/** A property the plans rely on, such as the marker property, and whether it holds unique values. */
export interface CrmProperty {
  readonly object: CrmObject;
  readonly name: string;
  readonly unique: boolean;
}

/**
 * What a connection's CRM holds that plans need: read when it's connected (WP5) and cached with the
 * connection, so planning reads no network.
 */
export interface CrmSchema {
  readonly stages: readonly CrmStage[];
  /** Empty when the CRM's tasks can't be assigned (`capabilities.owners` is false). */
  readonly owners: readonly CrmOwner[];
  /** One for every pair of objects the adapter's plans associate. */
  readonly associations: readonly CrmAssociationType[];
  readonly properties: readonly CrmProperty[];
}

/** A value as a CRM's API takes it: any JSON. */
export type CrmValue =
  | string
  | number
  | boolean
  | null
  | readonly CrmValue[]
  | { readonly [key: string]: CrmValue };

/**
 * What a plan is made from. The outbox's write steps rebuild it from Postgres rather than pass a
 * plan between steps (decision 15), so it holds ids and values, and never a credential.
 */
export interface PlanInput {
  /** The proposal: its type, normalized fields, and target. */
  readonly proposal: ProposalView;
  /** The approval the job syncs: its edits applied, its record chosen. */
  readonly review: ReviewView;
  /** The record the proposal changes, or null for a new one. */
  readonly target: MirrorRef | null;
  /** A contact's or a new deal's company, when it has one. */
  readonly company: MirrorRef | null;
  readonly mapping: CrmMapping;
  readonly schema: CrmSchema;
  /**
   * The rep: their CRM owner, when the mapping names one, and their IANA time zone, from
   * `session.started` v2 (UTC when the session recorded none).
   */
  readonly rep: { readonly ownerId: string | null; readonly timeZone: string };
  /** The job's idempotency key (`idempotencyKey`). */
  readonly key: string;
  /**
   * Each write's marker, by the plan's index: `marker(key, index)`. WebCrypto's digest is
   * asynchronous and `plan()` isn't, so the caller makes the markers first (WP1's addition to
   * §4.2's shape).
   */
  readonly markers: readonly string[];
}

/** Why a proposal can't be planned: a value the mapping can't read, the CRM can't hold, or refuses. */
export type PlanRefusal = "unmapped" | "unsupported" | "validation";

/** A plan, or why there's none, with the field to blame when one is. */
export type PlanResult =
  | { readonly ok: true; readonly plan: WritePlan }
  | {
      readonly ok: false;
      readonly kind: PlanRefusal;
      readonly field: string | null;
      /** Fixed words for the card ("HubSpot has no stage like this"), never a credential. */
      readonly reason: string;
    };

/** An approval as the ordered writes that make it in a CRM: version 1 of its form. */
export interface WritePlan {
  readonly v: 1;
  /** Values that must still be what the reviewer saw, read just before the first write. */
  readonly checks: readonly LiveCheck[];
  /** The writes, in order: 1 to 8. */
  readonly writes: readonly PlannedWrite[];
}

/**
 * A value the reviewer saw that the CRM must still hold (`seen.current`, else `seen.base`): one
 * that moved is a conflict, and the card comes back.
 */
export interface LiveCheck {
  readonly ref: ExternalRef;
  /** The proposal's field, such as `stage`. */
  readonly field: string;
  /** The CRM's name for it, such as HubSpot's `dealstage`. */
  readonly crmField: string;
  readonly seen: FieldValue;
}

/** What a write points at: a record the CRM has, or an earlier write of the same plan. */
export type WriteRef = ExternalRef | { readonly write: number };

/** One write of a plan, which a retry can repeat without a second record (decision 7). */
export interface PlannedWrite {
  /** Its place in the plan, from 0. */
  readonly index: number;
  readonly op: "create" | "update" | "associate";
  readonly object: CrmObject;
  /** `es_` and 20 base32 characters (`marker`): how a retry finds its first try. */
  readonly marker: string;
  /** What an update or an association starts from; null for a create. */
  readonly ref: WriteRef | null;
  /** The CRM's own property names and values, exactly as sent. */
  readonly properties: Readonly<Record<string, CrmValue>>;
  /** The associations to make, each with the CRM's type for it. */
  readonly associate: readonly { readonly to: WriteRef; readonly type: string | number }[];
}

/**
 * One request of the dry run ("Preview the write"), exactly as the adapter would send it, with the
 * credential shown as `Bearer •••`.
 */
export interface RequestPreview {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: CrmValue | null;
}

/** The connection a request goes to, without its credential. */
export interface CrmConnectionRef {
  /** The `crm_connections` row; null for the demo CRM. */
  readonly id: string | null;
  /** The CRM's account, such as HubSpot's hub id. */
  readonly accountId: string;
  /** Where its API is, such as `https://api.hubapi.com`. */
  readonly apiBase: string;
}

/** What `requests()` renders against: the connection, and nothing secret. */
export interface RenderContext {
  readonly connection: CrmConnectionRef;
}

/** How a call counts against the connection's limiter. */
export interface CallCost {
  readonly kind: "read" | "write" | "search";
}

/**
 * What an adapter's I/O goes through (decision 12): `fetch` waits for the connection's limiter,
 * adds the credential, and maps a 429 or a 401 to the taxonomy, so no adapter holds a token.
 */
export interface CrmContext extends RenderContext {
  fetch(request: Request, cost: CallCost): Promise<Response>;
}

/** Who and what a connection is, as `verify` reads it. */
export interface ConnectionInfo {
  readonly accountId: string;
  readonly accountName: string | null;
  /** Whose name the connection's writes carry; null when the CRM doesn't say. */
  readonly actor: {
    readonly id: string;
    readonly name: string | null;
    readonly email: string | null;
  } | null;
  readonly scopes: readonly string[];
}

/** A record as `get` reads it: each field asked for, in the form a live check compares. */
export interface CrmRecord {
  readonly ref: ExternalRef;
  readonly values: Readonly<Record<string, FieldValue>>;
}

/**
 * What a write did: the record it made, changed, or found (a retry finding its first try), or the
 * record it associated from. A write step returns this and nothing else (decision 15).
 */
export interface WriteOutcome {
  readonly index: number;
  readonly op: "created" | "updated" | "found" | "associated";
  readonly ref: ExternalRef;
}

/** Where the mirror's polling stands in a CRM: opaque to all but the adapter that made it. */
export type ChangeCursor = string;

/** A record that changed in the CRM, for the mirror (WP7). */
export interface CrmChange {
  readonly ref: ExternalRef;
  /** `deleted` when the CRM says the record went; `changed` for one made or edited. */
  readonly kind: "changed" | "deleted";
  readonly name: string | null;
  /** The fields the mirror keeps, in the form the cards read them. */
  readonly values: Readonly<Record<string, FieldValue>>;
  /** When the CRM changed it, by its own clock. */
  readonly at: string;
}

/** One page of changes, the cursor to read the next from, and whether more are waiting now. */
export interface ChangePage {
  readonly changes: readonly CrmChange[];
  readonly cursor: ChangeCursor;
  readonly more: boolean;
}

/**
 * An adapter to one CRM (decision 8). `plan` and `requests` are pure, so what the dry run shows is
 * what the outbox sends; `verify`, `schema`, `get`, `reconcile`, `execute`, and `changes` do their
 * I/O through `ctx.fetch`, and throw `CrmError`.
 */
export interface CrmAdapter {
  readonly provider: CrmProvider;
  readonly capabilities: Capabilities;
  /** The writes that make an approval: pure. */
  plan(input: PlanInput): PlanResult;
  /** A plan's requests, for the dry run: pure. */
  requests(plan: WritePlan, ctx: RenderContext): RequestPreview[];
  /** The account, the actor, and the scopes. */
  verify(ctx: CrmContext): Promise<ConnectionInfo>;
  schema(ctx: CrmContext): Promise<CrmSchema>;
  /** A record's fields, for a live check; null when the record is gone. */
  get(ref: ExternalRef, fields: readonly string[], ctx: CrmContext): Promise<CrmRecord | null>;
  /** A write's first try, found by its marker before it's repeated; null when there was none. */
  reconcile(
    write: PlannedWrite,
    done: readonly WriteOutcome[],
    ctx: CrmContext,
  ): Promise<WriteOutcome | null>;
  /** One write, with the outcomes of the writes before it, which later writes point at. */
  execute(
    write: PlannedWrite,
    done: readonly WriteOutcome[],
    ctx: CrmContext,
  ): Promise<WriteOutcome>;
  /** The changes since a cursor, a page at a time; from the start with a null cursor. */
  changes(cursor: ChangeCursor | null, ctx: CrmContext): Promise<ChangePage>;
}
