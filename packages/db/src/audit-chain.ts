// The audit chain from the app's side (docs/adr/0033). Postgres chains each workspace's audit_log
// rows with SHA-256 (migration 0013's trigger); this module appends rows, signs the chain's head
// as a checkpoint, exports a workspace's chain with every row's canonical text, and verifies an
// export offline, with nothing but the file and the public keys.
//
// recordAudit, writeCheckpoint, and exportAuditChain take a transaction from withTenant and check
// that it is one, so row-level security confines them to one workspace and entries name the user
// withTenant set. verifyAuditExport is pure.
import {
  type AuditPublicKey,
  type AuditSigner,
  fromHex,
  isAuditPublicKey,
  isDevelopmentAuditKey,
  signCheckpoint,
  toBase64Url,
  toHex,
  verifyCheckpoint,
} from "@earshot/keys/server";
import { and, asc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { type AuditCheckpointRequest, auditCheckpoints, auditLog } from "./schema";
import { currentTenant } from "./tenant";

/** The canonical text's form: its first element. A change to the text would be form 2. */
export const AUDIT_FORM_VERSION = 1;

/** The first row's `prev_hash`: 32 zero bytes, in hex. */
export const ZERO_HASH_HEX = "0".repeat(64);

/** Postgres's rendering of a time in the canonical text, as `audit_entry_canonical` writes it. */
const CANONICAL_TIME = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
/** A checkpoint's signed time, with milliseconds, as `Date.toISOString` writes it. */
const SIGNED_TIME = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * One entry to append. The actor is always the transaction's user; the chain columns and the time
 * are the trigger's.
 */
export interface AuditEntryInput {
  /** Dotted, for example `proposal.approved`. */
  readonly action: string;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A workspace's newest chain row: what a checkpoint signs. */
export interface AuditHead {
  readonly workspaceId: string;
  readonly seq: number;
  /** 32 bytes. */
  readonly entryHash: Uint8Array;
}

export interface RecordedAudit {
  /** The appended rows, in chain order. */
  readonly entries: readonly {
    readonly id: string;
    readonly seq: number;
    readonly entryHash: Uint8Array;
  }[];
  /** The chain's head after the append: the last of them. */
  readonly head: AuditHead;
}

type Tx<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgTransaction<TQueryResult, TFullSchema, TSchema>;

/**
 * Appends entries to the transaction's workspace's chain, in the transaction's user's name, in the
 * order given, and returns them with the new head. The trigger numbers and hashes them, and holds
 * the workspace's audit lock until the transaction ends, so take any session lock first (the order
 * the spec fixes for every writer: session, then audit). Throws a TypeError for an empty list.
 */
export async function recordAudit<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  entries: readonly AuditEntryInput[],
): Promise<RecordedAudit> {
  const { userId, workspaceId } = await currentTenant(tx, "recordAudit");
  if (entries.length === 0) throw new TypeError("recordAudit: no entries to record");
  for (const entry of entries) {
    if (typeof entry.action !== "string" || entry.action.trim() === "") {
      throw new TypeError("recordAudit: every entry needs an action");
    }
  }
  const rows = await tx
    .insert(auditLog)
    .values(
      entries.map((entry) => ({
        workspaceId,
        actorUserId: userId,
        action: entry.action,
        subjectType: entry.subjectType ?? null,
        subjectId: entry.subjectId ?? null,
        detail: { ...(entry.detail ?? {}) },
      })),
    )
    .returning({ id: auditLog.id, seq: auditLog.chainSeq, entryHash: auditLog.entryHash });
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const last = ordered.at(-1);
  if (!last) throw new Error("recordAudit: the insert returned no rows");
  return { entries: ordered, head: { workspaceId, seq: last.seq, entryHash: last.entryHash } };
}

/** A stored checkpoint. */
export interface AuditCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly seq: number;
  readonly entryHash: Uint8Array;
  /** As signed: ISO 8601 in UTC with milliseconds. */
  readonly signedAt: string;
  readonly kid: string;
  /** 64 bytes. */
  readonly signature: Uint8Array;
  readonly request: AuditCheckpointRequest;
}

/** The head given to writeCheckpoint isn't a row of this workspace's chain. Nothing was signed. */
export class AuditHeadError extends Error {
  override readonly name = "AuditHeadError";
}

/**
 * Signs `head` with `signer` and stores the checkpoint, in the transaction's workspace. One per
 * review request (each web request with reviews, each flush message carrying review events, each
 * policy change) and per account export. Refuses (AuditHeadError) a head from another workspace or
 * one that doesn't match the stored row, so a checkpoint never vouches for a hash the chain
 * doesn't hold.
 */
export async function writeCheckpoint<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: Tx<TQueryResult, TFullSchema, TSchema>,
  signer: AuditSigner,
  head: AuditHead,
  request: AuditCheckpointRequest,
  at: Date = new Date(),
): Promise<AuditCheckpoint> {
  const { workspaceId } = await currentTenant(tx, "writeCheckpoint");
  if (head.workspaceId !== workspaceId) {
    throw new AuditHeadError("writeCheckpoint: the head is from another workspace");
  }
  const [stored] = await tx
    .select({ entryHash: auditLog.entryHash })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.chainSeq, head.seq)));
  if (!stored || toHex(stored.entryHash) !== toHex(head.entryHash)) {
    throw new AuditHeadError("writeCheckpoint: the head doesn't match the stored chain");
  }
  const signed = await signCheckpoint(
    signer,
    { workspaceId, seq: head.seq, head: head.entryHash },
    at,
  );
  const [row] = await tx
    .insert(auditCheckpoints)
    .values({
      workspaceId,
      chainSeq: head.seq,
      entryHash: head.entryHash,
      signedAt: new Date(signed.ts),
      kid: signed.kid,
      signature: signed.signature,
      request,
    })
    .returning({ id: auditCheckpoints.id });
  if (!row) throw new Error("writeCheckpoint: the insert returned no row");
  return {
    id: row.id,
    workspaceId,
    seq: head.seq,
    entryHash: head.entryHash,
    signedAt: signed.ts,
    kid: signed.kid,
    signature: signed.signature,
    request,
  };
}

/** One chain row in an export: its columns, its hashes in hex, and the canonical text they cover. */
export interface AuditEntryExport {
  readonly id: string;
  readonly workspaceId: string;
  readonly chainSeq: number;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly detail: Record<string, unknown>;
  /** As in the canonical text: ISO 8601 in UTC, to the microsecond. */
  readonly at: string;
  /** 64 hex digits. */
  readonly prevHash: string;
  /** 64 hex digits: SHA-256 of `prevHash`'s bytes and `canonical` as UTF-8. */
  readonly entryHash: string;
  /** `audit_entry_canonical` of the row: what `entryHash` covers. */
  readonly canonical: string;
}

/** One checkpoint in an export. */
export interface AuditCheckpointExport {
  readonly id: string;
  readonly workspaceId: string;
  readonly chainSeq: number;
  /** 64 hex digits. */
  readonly entryHash: string;
  /** As signed: ISO 8601 in UTC with milliseconds. */
  readonly signedAt: string;
  readonly kid: string;
  /** 64 bytes, base64url without padding. */
  readonly signature: string;
  readonly request: AuditCheckpointRequest;
}

/** A workspace's chain and checkpoints, ready for JSON. */
export interface AuditChainExport {
  readonly workspaceId: string;
  readonly entries: AuditEntryExport[];
  readonly checkpoints: AuditCheckpointExport[];
}

/**
 * The transaction's workspace's whole chain, in seq order, with each row's canonical text from
 * Postgres's own `audit_entry_canonical`, and its checkpoints. Everything in it is JSON-safe.
 */
export async function exportAuditChain<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: Tx<TQueryResult, TFullSchema, TSchema>): Promise<AuditChainExport> {
  const { workspaceId } = await currentTenant(tx, "exportAuditChain");
  // Row-level security limits both reads to the transaction's workspace.
  const entries = await tx
    .select({
      id: auditLog.id,
      workspaceId: auditLog.workspaceId,
      chainSeq: auditLog.chainSeq,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      subjectType: auditLog.subjectType,
      subjectId: auditLog.subjectId,
      detail: auditLog.detail,
      at: sql<string>`to_char(${auditLog.at} at time zone 'UTC', ${sql.raw(CANONICAL_TIME)})`,
      prevHash: sql<string>`encode(${auditLog.prevHash}, 'hex')`,
      entryHash: sql<string>`encode(${auditLog.entryHash}, 'hex')`,
      canonical: sql<string>`public.audit_entry_canonical(${auditLog})`,
    })
    .from(auditLog)
    .orderBy(asc(auditLog.chainSeq));
  const checkpoints = await tx
    .select({
      id: auditCheckpoints.id,
      workspaceId: auditCheckpoints.workspaceId,
      chainSeq: auditCheckpoints.chainSeq,
      entryHash: sql<string>`encode(${auditCheckpoints.entryHash}, 'hex')`,
      signedAt: sql<string>`to_char(${auditCheckpoints.signedAt} at time zone 'UTC', ${sql.raw(SIGNED_TIME)})`,
      kid: auditCheckpoints.kid,
      signature: auditCheckpoints.signature,
      request: auditCheckpoints.request,
    })
    .from(auditCheckpoints)
    .orderBy(
      asc(auditCheckpoints.chainSeq),
      asc(auditCheckpoints.signedAt),
      asc(auditCheckpoints.id),
    );
  return {
    workspaceId,
    entries,
    checkpoints: checkpoints.map((checkpoint) => ({
      ...checkpoint,
      signature: toBase64Url(checkpoint.signature),
    })),
  };
}

/** What kind of fault the verifier found. */
export type AuditProblemKind =
  | "malformed"
  | "form"
  | "workspace"
  | "duplicate"
  | "gap"
  | "prev_hash"
  | "entry_hash"
  | "canonical"
  | "checkpoint_head"
  | "unknown_kid"
  | "bad_signature"
  | "signed_after_retirement"
  | "unsigned_tail";

export interface AuditProblem {
  /** Null for a fault with the file as a whole. */
  readonly workspaceId: string | null;
  readonly seq?: number;
  readonly checkpointId?: string;
  readonly kind: AuditProblemKind;
  /**
   * One sentence, naming seqs, ids (checked to be UUIDs), and key ids (quoted, with controls
   * escaped), never a row's contents.
   */
  readonly message: string;
}

export interface AuditWorkspaceReport {
  readonly workspaceId: string;
  readonly entries: number;
  readonly checkpoints: number;
  /** The newest row, as exported. */
  readonly head: { readonly seq: number; readonly entryHash: string } | null;
  /**
   * The highest seq signed by a valid checkpoint that counts, or null if none does. Checkpoints
   * signed with the development key count only with `allowDevelopmentKey`.
   */
  readonly signedThrough: number | null;
  /** Entries after `signedThrough` up to the head: chained, but signed by no checkpoint that counts. */
  readonly unsignedTail: number;
  /** Valid checkpoints signed with the development key, which anyone can make. */
  readonly developmentSignatures: number;
}

export interface AuditVerifyOptions {
  /** The public keys to check signatures with. The export's own `audit.keys` by default. */
  readonly keys?: readonly AuditPublicKey[];
  /**
   * Accept entries after the last signed checkpoint, as in an export taken between checkpoints:
   * they're no longer problems, and the result says the chain is intact with N entries unsigned.
   * It's still not `ok`.
   */
  readonly allowUnsignedTail?: boolean;
  /** Count checkpoints signed with the committed development key, as for a development export. */
  readonly allowDevelopmentKey?: boolean;
}

export interface AuditVerification {
  /**
   * True only when the chain holds and every workspace with entries is signed through its head by
   * a valid checkpoint from a deployment key (or from the development key, if allowed). An
   * unsigned tail is never ok, accepted or not.
   */
  readonly ok: boolean;
  /** Every link, hash, canonical text, and checkpoint holds, whether or not it's all signed. */
  readonly intact: boolean;
  /** Entries no checkpoint that counts signs, across workspaces. */
  readonly unsignedEntries: number;
  /** Where the public keys came from: the export itself, or the caller. */
  readonly keySource: "export" | "supplied";
  readonly workspaces: readonly AuditWorkspaceReport[];
  /** What fails the check: integrity faults, and unsigned tails unless `allowUnsignedTail`. */
  readonly problems: readonly AuditProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX_64 = /^[0-9a-f]{64}$/;
/** Ids as Postgres writes them. An export's workspace and checkpoint ids must look like this. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Characters that steer a terminal or reorder text: C0, DEL, C1, line separators, bidi marks. */
function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * `text` with every control character (C0, DEL, C1), line and paragraph separator, and
 * bidirectional mark, embedding, override, or isolate written as `\uXXXX`. Everything an export
 * or a keys file supplies goes through this before it's printed, so a crafted file can't move the
 * cursor, recolour, erase, or reorder a terminal's output. Scans by code unit, with no regex.
 */
export function escapeControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : text.charAt(i);
  }
  return out;
}

/** A string from a file, for a message: JSON-quoted, with every control character escaped. */
function quoted(text: string): string {
  return escapeControls(JSON.stringify(text));
}

/** Equality of two JSON values: objects regardless of key order, arrays in order. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

const encoder = new TextEncoder();

function isEntry(value: unknown): value is AuditEntryExport {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    Number.isSafeInteger(value.chainSeq) &&
    (value.chainSeq as number) > 0 &&
    (value.actorUserId === null || typeof value.actorUserId === "string") &&
    typeof value.action === "string" &&
    (value.subjectType === null || typeof value.subjectType === "string") &&
    (value.subjectId === null || typeof value.subjectId === "string") &&
    isRecord(value.detail) &&
    typeof value.at === "string" &&
    typeof value.prevHash === "string" &&
    HEX_64.test(value.prevHash) &&
    typeof value.entryHash === "string" &&
    HEX_64.test(value.entryHash) &&
    typeof value.canonical === "string"
  );
}

function isCheckpoint(value: unknown): value is AuditCheckpointExport {
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    typeof value.workspaceId === "string" &&
    Number.isSafeInteger(value.chainSeq) &&
    typeof value.entryHash === "string" &&
    HEX_64.test(value.entryHash) &&
    typeof value.signedAt === "string" &&
    typeof value.kid === "string" &&
    typeof value.signature === "string"
  );
}

/** Whether a row's canonical text says what the row's own columns say. */
function canonicalMatches(entry: AuditEntryExport): "ok" | "form" | "mismatch" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.canonical);
  } catch {
    return "mismatch";
  }
  if (!Array.isArray(parsed) || parsed.length !== 9) return "mismatch";
  if (parsed[0] !== AUDIT_FORM_VERSION) return "form";
  const expected = [
    AUDIT_FORM_VERSION,
    entry.workspaceId,
    entry.chainSeq,
    entry.actorUserId,
    entry.action,
    entry.subjectType,
    entry.subjectId,
    entry.detail,
    entry.at,
  ];
  return jsonEqual(parsed, expected) ? "ok" : "mismatch";
}

type ExportedWorkspace = {
  readonly id: string;
  readonly entries: readonly unknown[];
  readonly checkpoints: readonly unknown[];
};

/**
 * The export's workspaces, with ids checked before anything else reads them, or why the file is
 * refused. Refusals name no value from the file.
 */
function parseExport(
  json: unknown,
): { workspaces: ExportedWorkspace[]; keys: AuditPublicKey[] } | AuditProblem {
  const refuse = (kind: AuditProblemKind, message: string): AuditProblem => ({
    workspaceId: null,
    kind,
    message,
  });
  if (
    !isRecord(json) ||
    json.format !== "earshot.account-export" ||
    !Array.isArray(json.workspaces)
  ) {
    return refuse("malformed", "This isn't an Earshot account export.");
  }
  const audit = isRecord(json.audit) ? json.audit : undefined;
  if (audit?.form !== AUDIT_FORM_VERSION) {
    return refuse("form", `The export's audit section isn't form ${AUDIT_FORM_VERSION}.`);
  }
  if (!Array.isArray(audit.keys) || !audit.keys.every(isAuditPublicKey)) {
    return refuse("malformed", "The export's audit keys aren't well-formed public keys.");
  }
  const workspaces: ExportedWorkspace[] = [];
  for (const workspace of json.workspaces) {
    if (!isRecord(workspace) || !isUuid(workspace.id)) {
      return refuse("malformed", "A workspace's id isn't a UUID, so the file was refused.");
    }
    const tables = isRecord(workspace.tables) ? workspace.tables : undefined;
    const entries = tables?.audit_log;
    const checkpoints = tables?.audit_checkpoints;
    if (!Array.isArray(entries) || !Array.isArray(checkpoints)) {
      return refuse("malformed", "A workspace lacks its audit_log or audit_checkpoints table.");
    }
    if (!checkpoints.every((checkpoint) => isRecord(checkpoint) && isUuid(checkpoint.id))) {
      return refuse("malformed", "A checkpoint's id isn't a UUID, so the file was refused.");
    }
    workspaces.push({ id: workspace.id, entries, checkpoints });
  }
  return { workspaces, keys: audit.keys };
}

function entryRange(from: number, to: number): string {
  return to > from ? `Entries ${from} to ${to} aren't` : `Entry ${from} isn't`;
}

/**
 * Checks an account export's audit chains and checkpoints, offline (docs/adr/0033). The file must
 * be well formed first: an Earshot export of form 1, well-formed public keys, and UUIDs for every
 * workspace and checkpoint id; anything else is refused before it's read further. Then, per
 * workspace: seqs run from 1 with no gap or repeat; each row links to the one before
 * (`prevHash`); each `entryHash` is SHA-256 of `prevHash`'s bytes and the canonical text as
 * UTF-8; each canonical text parses to its own row's columns; each checkpoint names a row with
 * the hash it signed and carries a valid Ed25519 signature from a listed key, within that key's
 * retirement; and the newest row is signed.
 *
 * `ok` holds only when every workspace with entries is signed through its head by a checkpoint
 * that counts: one from a deployment key, or from the development key with `allowDevelopmentKey`.
 * Entries after the last such checkpoint are an unsigned tail: anyone with the database could have
 * changed or dropped them. Each one is a problem, unless `allowUnsignedTail` accepts an export
 * taken between checkpoints, and then the result is intact but still not `ok`.
 *
 * The keys come from the export itself unless `keys` supplies them. Keys saved separately from
 * `/api/audit/keys` make a stronger check: whoever could rewrite the file could rewrite its keys.
 * The second argument may also be a key list, as `verifyAuditExport(json, keys)`.
 */
export async function verifyAuditExport(
  json: unknown,
  options: AuditVerifyOptions | readonly AuditPublicKey[] = {},
): Promise<AuditVerification> {
  const {
    keys,
    allowUnsignedTail = false,
    allowDevelopmentKey = false,
  } = Array.isArray(options)
    ? { keys: options as readonly AuditPublicKey[] }
    : (options as AuditVerifyOptions);
  const keySource = keys ? "supplied" : "export";
  const refused = (problem: AuditProblem): AuditVerification => ({
    ok: false,
    intact: false,
    unsignedEntries: 0,
    keySource,
    workspaces: [],
    problems: [problem],
  });

  const parsed = parseExport(json);
  if (!("workspaces" in parsed)) return refused(parsed);
  if (keys && !keys.every(isAuditPublicKey)) {
    return refused({
      workspaceId: null,
      kind: "malformed",
      message: "The keys given aren't well-formed public keys.",
    });
  }
  const usedKeys = keys ?? parsed.keys;

  const problems: AuditProblem[] = [];
  const tails: AuditProblem[] = [];
  const reports: AuditWorkspaceReport[] = [];
  const fail = (problem: AuditProblem) => problems.push(problem);

  for (const {
    id: workspaceId,
    entries: rawEntries,
    checkpoints: rawCheckpoints,
  } of parsed.workspaces) {
    const entries: AuditEntryExport[] = [];
    for (const entry of rawEntries) {
      if (isEntry(entry)) entries.push(entry);
      else fail({ workspaceId, kind: "malformed", message: "An audit entry is malformed." });
    }
    entries.sort((a, b) => a.chainSeq - b.chainSeq);

    // The chain: links, hashes, and canonical texts, from seq 1.
    const bySeq = new Map<number, AuditEntryExport>();
    let expected = 1;
    let prev = ZERO_HASH_HEX;
    for (const entry of entries) {
      const seq = entry.chainSeq;
      if (bySeq.has(seq)) {
        fail({ workspaceId, seq, kind: "duplicate", message: `Seq ${seq} appears twice.` });
        continue;
      }
      bySeq.set(seq, entry);
      if (entry.workspaceId !== workspaceId) {
        fail({
          workspaceId,
          seq,
          kind: "workspace",
          message: `Seq ${seq} names another workspace.`,
        });
      }
      if (seq !== expected) {
        fail({
          workspaceId,
          seq: expected,
          kind: "gap",
          message:
            seq > expected
              ? `Seq ${expected}${seq - 1 > expected ? ` to ${seq - 1}` : ""} is missing.`
              : `Seq ${seq} is out of place.`,
        });
        expected = seq;
      }
      if (entry.prevHash !== prev) {
        fail({
          workspaceId,
          seq,
          kind: "prev_hash",
          message: `Seq ${seq}'s prevHash isn't the entryHash of the row before it.`,
        });
      }
      const hashed = toHex(
        await sha256(
          new Uint8Array([...fromHex(entry.prevHash), ...encoder.encode(entry.canonical)]),
        ),
      );
      if (hashed !== entry.entryHash) {
        fail({
          workspaceId,
          seq,
          kind: "entry_hash",
          message: `Seq ${seq}'s entryHash isn't SHA-256 of its prevHash and canonical text.`,
        });
      }
      const canonical = canonicalMatches(entry);
      if (canonical !== "ok") {
        fail({
          workspaceId,
          seq,
          kind: canonical === "form" ? "form" : "canonical",
          message:
            canonical === "form"
              ? `Seq ${seq}'s canonical text isn't form ${AUDIT_FORM_VERSION}.`
              : `Seq ${seq}'s canonical text doesn't match the row's columns.`,
        });
      }
      prev = entry.entryHash;
      expected = seq + 1;
    }

    // The checkpoints: each names a row with the hash it signed, under a valid signature from a
    // listed key. Only those that count move signedThrough.
    let signedThrough: number | null = null;
    let developmentSignatures = 0;
    let checkpointCount = 0;
    for (const checkpoint of rawCheckpoints) {
      if (!isCheckpoint(checkpoint)) {
        fail({ workspaceId, kind: "malformed", message: "A checkpoint is malformed." });
        continue;
      }
      checkpointCount++;
      const at = { workspaceId, seq: checkpoint.chainSeq, checkpointId: checkpoint.id };
      const row = bySeq.get(checkpoint.chainSeq);
      if (
        checkpoint.workspaceId !== workspaceId ||
        !row ||
        row.entryHash !== checkpoint.entryHash
      ) {
        fail({
          ...at,
          kind: "checkpoint_head",
          message: `Checkpoint ${checkpoint.id} signed a head (seq ${checkpoint.chainSeq}) this chain doesn't hold.`,
        });
        continue;
      }
      if (!usedKeys.some((key) => key.kid === checkpoint.kid)) {
        fail({
          ...at,
          kind: "unknown_kid",
          message: `Checkpoint ${checkpoint.id} is signed by key ${quoted(checkpoint.kid)}, which isn't among the keys.`,
        });
        continue;
      }
      const verdict = await verifyCheckpoint(usedKeys, {
        workspaceId: checkpoint.workspaceId,
        seq: checkpoint.chainSeq,
        head: checkpoint.entryHash,
        ts: checkpoint.signedAt,
        kid: checkpoint.kid,
        signature: checkpoint.signature,
      });
      if (!verdict.ok) {
        fail({
          ...at,
          kind: verdict.reason === "signed_after_retirement" ? verdict.reason : "bad_signature",
          message:
            verdict.reason === "signed_after_retirement"
              ? `Checkpoint ${checkpoint.id} was signed after its key was retired.`
              : `Checkpoint ${checkpoint.id}'s signature doesn't verify.`,
        });
        continue;
      }
      const development = isDevelopmentAuditKey(verdict.key);
      if (development) developmentSignatures++;
      if (!development || allowDevelopmentKey) {
        signedThrough = Math.max(signedThrough ?? 0, checkpoint.chainSeq);
      }
    }

    const last = entries.at(-1);
    const headSeq = last?.chainSeq ?? 0;
    const unsignedTail = Math.max(0, headSeq - (signedThrough ?? 0));
    if (unsignedTail > 0) {
      const from = headSeq - unsignedTail + 1;
      tails.push({
        workspaceId,
        seq: from,
        kind: "unsigned_tail",
        message: `${entryRange(from, headSeq)} signed by any checkpoint${
          developmentSignatures > 0 && !allowDevelopmentKey
            ? " from a deployment key (the development key's don't count)"
            : ""
        }, so anyone with the database could have changed or dropped ${headSeq > from ? "them" : "it"}.`,
      });
    }
    reports.push({
      workspaceId,
      entries: entries.length,
      checkpoints: checkpointCount,
      head: last ? { seq: last.chainSeq, entryHash: last.entryHash } : null,
      signedThrough,
      unsignedTail,
      developmentSignatures,
    });
  }

  const intact = problems.length === 0;
  const unsignedEntries = reports.reduce((sum, report) => sum + report.unsignedTail, 0);
  return {
    ok: intact && unsignedEntries === 0,
    intact,
    unsignedEntries,
    keySource,
    workspaces: reports,
    problems: allowUnsignedTail ? problems : [...problems, ...tails],
  };
}
