import { z } from "zod";
import { FieldName, FieldValue, MAX_SYNC_ATTEMPTS, payloadMeta, Sha256Hex } from "./shared";

// The sync's own events (Phase 6 spec §4.1, decisions 4 to 6; ADR-0040). The outbox appends them to
// a session's log after the seal, under the session's lock, as Phase 5's writers append reviews:
// `proposal.sync_started` when it claims a job, the point of no return (from it on nothing reopens
// the proposal), then one result for that attempt, `proposal.synced`, `proposal.sync_failed`, or
// `proposal.sync_conflicted`. Each names its job, the review it syncs, the attempt, and the CRM; the
// proposal is the one whose latest review that is. The rules the writers keep, which the schemas
// can't express in JSON Schema and therefore don't check, are `checkSyncEvent` in
// `@earshot/events`.

/** The CRMs Earshot syncs to, and its own demo CRM. */
export const CrmProvider = z.enum(["hubspot", "twenty", "attio", "demo"]);
export type CrmProvider = z.infer<typeof CrmProvider>;

/** What a record is in a CRM: the records proposals change, and the activities a sync writes. */
export const CrmObject = z.enum(["company", "contact", "deal", "note", "task", "meeting"]);
export type CrmObject = z.infer<typeof CrmObject>;

/** The most writes one sync plans (target), so the most records one attempt reports. */
export const MAX_SYNC_WRITES = 8;

/** The longest link to a record a sync event holds. */
export const MAX_CRM_URL_CHARS = 2048;

/**
 * A record's link in its CRM's own app, which the inbox shows as a link ("Open in HubSpot"): `http`
 * or `https` only, a host with no spaces or credentials, then any path, query, or fragment without
 * spaces, at most 2,048 characters. A review fix: the spec's `z.url()` takes any scheme,
 * `javascript:` and `data:` among them. It's a pattern rather than `z.url()`, so the JSON Schema
 * export carries the rule to the lab: Pydantic drops a pattern and a length on a `format: uri`
 * string. `http` is for a self-hosted Twenty on `localhost`, in development and in CI.
 */
export const CrmRecordUrl = z
  .string()
  .max(MAX_CRM_URL_CHARS)
  .regex(/^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/);

/** A record in a CRM: what it is, its id there, and its link in the CRM's app. */
export const ExternalRef = z
  .strictObject({
    object: CrmObject,
    id: z.string().min(1).max(256),
    /** The record in the CRM's own app, when the adapter knows the link; null otherwise. */
    url: CrmRecordUrl.nullable(),
  })
  .meta({ title: "ExternalRef" });
export type ExternalRef = z.infer<typeof ExternalRef>;

/**
 * Why a write didn't land, as the adapter SDK's error taxonomy names it (Phase 6 spec §4.2): a
 * CRM's 429 (`rate_limited`); a 5xx, a network error, or a timeout (`transient`); a 401 or a revoked
 * grant (`auth`); a 403 or a missing scope (`forbidden`); a 404 (`not_found`); a value the CRM
 * refused (`validation`); a unique value already taken (`duplicate`); a stage or owner the mapping
 * can't read (`unmapped`); a proposal the CRM can't hold (`unsupported`); or anything else
 * (`unknown`).
 */
export const SyncErrorKind = z.enum([
  "rate_limited",
  "transient",
  "auth",
  "forbidden",
  "not_found",
  "validation",
  "duplicate",
  "unmapped",
  "unsupported",
  "unknown",
]);
export type SyncErrorKind = z.infer<typeof SyncErrorKind>;

/** What a write did: made a record, changed one, or found what a first try had made. */
export const SyncRecordOp = z.enum(["created", "updated", "found"]);
export type SyncRecordOp = z.infer<typeof SyncRecordOp>;

/** Why a sync stopped to ask: the CRM's value moved, the record is gone, or the person exists. */
export const SyncConflictCause = z.enum(["moved", "gone", "duplicate"]);
export type SyncConflictCause = z.infer<typeof SyncConflictCause>;

/**
 * What every sync event names: the job, the approval it syncs (its `reviewId`), which attempt (a
 * Retry starts the next, under the same key), and the CRM.
 */
const SyncAttempt = {
  jobId: z.uuid(),
  reviewId: z.uuid(),
  attempt: z.int().min(1).max(MAX_SYNC_ATTEMPTS),
  provider: CrmProvider,
};

/** The mapping version a job plans with, and the SHA-256 of its canonical JSON. */
export const SyncMappingRef = z
  .strictObject({ version: z.int().positive(), sha256: Sha256Hex })
  .meta({ title: "SyncMappingRef" });
export type SyncMappingRef = z.infer<typeof SyncMappingRef>;

/**
 * The outbox claimed a job (Phase 6 spec decision 5): under the session's lock, after it re-read
 * the proposal's latest review, which is still the job's approval or edit. From here on nothing
 * reopens the proposal; the attempt ends with one result. A Retry is a new attempt, which starts
 * again from here.
 */
export const ProposalSyncStartedV1 = z
  .strictObject({
    ...SyncAttempt,
    /** The CRM connection it writes through; null for the demo CRM. */
    connectionId: z.uuid().nullable(),
    /** The connection's mapping version it plans with; null where there's none. */
    mapping: SyncMappingRef.nullable(),
    /** Whether "Sync now" skipped the undo window (WP13); false otherwise. */
    waivedWindow: z.boolean(),
  })
  .meta(
    payloadMeta(
      "proposal.sync_started",
      1,
      "ProposalSyncStartedV1",
      "Payload of `proposal.sync_started`, schema version 1: the outbox claimed a job, the point after which nothing reopens the proposal.",
    ),
  );
export type ProposalSyncStartedV1 = z.infer<typeof ProposalSyncStartedV1>;

/** One record a sync's write made, changed, or found, by the plan's index of that write. */
export const SyncedRecord = z
  .strictObject({
    write: z.int().nonnegative(),
    op: SyncRecordOp,
    ref: ExternalRef,
  })
  .meta({ title: "SyncedRecord" });
export type SyncedRecord = z.infer<typeof SyncedRecord>;

/** Every write of the attempt landed: the records they made, changed, or found, in plan order. */
export const ProposalSyncedV1 = z
  .strictObject({
    ...SyncAttempt,
    records: z.array(SyncedRecord).min(1).max(MAX_SYNC_WRITES),
    /** How many associations the writes made between records. */
    associations: z.int().nonnegative(),
  })
  .meta(
    payloadMeta(
      "proposal.synced",
      1,
      "ProposalSyncedV1",
      "Payload of `proposal.synced`, schema version 1: every write of a sync attempt landed, with the CRM's records.",
    ),
  );
export type ProposalSyncedV1 = z.infer<typeof ProposalSyncedV1>;

/**
 * The attempt failed for good: a kind that isn't retried, or retries that ran out. What landed
 * before the failure is listed, so a Retry (the same key and markers) finds it again.
 */
export const ProposalSyncFailedV1 = z
  .strictObject({
    ...SyncAttempt,
    kind: SyncErrorKind,
    /** The CRM's error code or category, never its message. */
    code: z.string().max(64).nullable(),
    /** The field a validation or unmapped error names. */
    field: FieldName.nullable(),
    /** Writes that landed before the failure. */
    landed: z.array(ExternalRef).max(MAX_SYNC_WRITES),
    /** Whether Retry is offered (after reconnecting, for `auth`). */
    retryable: z.boolean(),
  })
  .meta(
    payloadMeta(
      "proposal.sync_failed",
      1,
      "ProposalSyncFailedV1",
      "Payload of `proposal.sync_failed`, schema version 1: a sync attempt failed for good, with why and what landed before.",
    ),
  );
export type ProposalSyncFailedV1 = z.infer<typeof ProposalSyncFailedV1>;

/** A field whose value in the CRM isn't what the reviewer saw: what they saw, and what's there. */
export const SyncConflictField = z
  .strictObject({ seen: FieldValue, live: FieldValue })
  .meta({ title: "SyncConflictField" });
export type SyncConflictField = z.infer<typeof SyncConflictField>;

/**
 * The attempt stopped before writing (Phase 6 spec decision 6): a value the reviewer saw moved in
 * the CRM, the record was deleted there, or the person already exists. The outbox appends a system
 * reopen (`proposal.reviewed` v3, `reason: "conflict"`) right after it, in the same transaction, so
 * the card comes back to the reviewer.
 */
export const ProposalSyncConflictedV1 = z
  .strictObject({
    ...SyncAttempt,
    cause: SyncConflictCause,
    /** The fields that moved, by name: at least one when the cause is `moved`. */
    fields: z.record(FieldName, SyncConflictField),
    /** For `duplicate`: the record that already holds this person. */
    existing: ExternalRef.nullable(),
  })
  .meta(
    payloadMeta(
      "proposal.sync_conflicted",
      1,
      "ProposalSyncConflictedV1",
      "Payload of `proposal.sync_conflicted`, schema version 1: a sync attempt found the CRM had changed under the approval, and stopped to ask again.",
    ),
  );
export type ProposalSyncConflictedV1 = z.infer<typeof ProposalSyncConflictedV1>;
