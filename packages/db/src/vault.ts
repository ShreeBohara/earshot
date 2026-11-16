// The optional server vault for AI provider keys (docs/adr/0009, docs/adr/0021): the data layer
// over `credentials`. Each key is sealed with its own data key, which the master key wraps, and
// both layers authenticate the row's context (workspace and slot), so a sealed row copied to
// another workspace or slot no longer opens. Only metadata comes back out, except from
// revealCredential, which returns the plaintext for server-side provider calls.
//
// Every function takes a transaction from withTenant and checks that it is one: row-level
// security then confines it to the workspace withTenant set, and audit entries name the user
// withTenant set.
import {
  isProviderId,
  last4,
  openSecret,
  type ProviderId,
  redact,
  type SealedSecret,
  sealSecret,
  VAULT_MASTER_KEY_ENV,
  vaultContext,
} from "@earshot/keys/server";
import { and, asc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { auditLog, credentials } from "./schema";
import { TENANT_ROLE } from "./tenant";

/** A key's slot within its workspace. Each slot holds at most one key. */
export interface CredentialSlot {
  readonly provider: ProviderId;
  /** `default` when omitted. */
  readonly label?: string;
}

export interface PutCredentialInput extends CredentialSlot {
  readonly secret: string;
  /** When the key last passed validation, if it did. A replacement resets it. */
  readonly validatedAt?: Date | null;
}

/** What the vault says about a stored key. Never the key itself, nor its envelope. */
export interface CredentialMeta {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly last4: string;
  readonly validatedAt: Date | null;
  /** When the slot was first filled. Replacing the key keeps it; the audit log has the rest. */
  readonly createdAt: Date;
}

/** Thrown by putCredential and revealCredential when the vault is off. Nothing is written. */
export class VaultOffError extends Error {
  constructor() {
    super(`The vault is off (${VAULT_MASTER_KEY_ENV} isn't set), so keys can't be stored.`);
    this.name = "VaultOffError";
  }
}

/**
 * Thrown when a sealed secret doesn't open: the master key is a different one, or the row was
 * moved to another workspace or slot, or tampered with.
 */
export class VaultOpenError extends Error {
  constructor(options?: ErrorOptions) {
    super("A vault secret didn't open with this master key and its row's context.", options);
    this.name = "VaultOpenError";
  }
}

/** The context a credential is sealed under: its workspace and its slot. */
export function credentialContext(row: {
  readonly workspaceId: string;
  readonly provider: string;
  readonly label: string;
}): string {
  return vaultContext(row.workspaceId, "credential", `${row.provider}:${row.label}`);
}

/**
 * The context a CRM connection's token is sealed under: its workspace, provider, and row id.
 * `crm_connections` has no unique slot (a workspace can hold one connection per rep), so the id
 * is what pins a token to its row. Whatever writes these rows must seal with this context, and
 * generate the id before sealing.
 */
export function crmConnectionContext(row: {
  readonly workspaceId: string;
  readonly provider: string;
  readonly id: string;
}): string {
  return vaultContext(row.workspaceId, "crm_connection", `${row.provider}:${row.id}`);
}

const DEFAULT_LABEL = "default";
const MAX_LABEL_LENGTH = 64;
const MAX_SECRET_LENGTH = 4096;

/** The only columns that leave the vault, except through revealCredential. */
const metadata = {
  id: credentials.id,
  provider: credentials.provider,
  label: credentials.label,
  last4: credentials.last4,
  validatedAt: credentials.validatedAt,
  createdAt: credentials.createdAt,
};

/**
 * Seals `secret` into its slot, replacing any key already there, and records `credential.stored`
 * or `credential.replaced` in the audit log with the provider, label, and last four characters.
 *
 * Pass `loadVaultMasterKey`'s result as `master`. While the vault is off it is null, and this
 * throws VaultOffError before touching the database.
 */
export async function putCredential<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  master: CryptoKey | null,
  input: PutCredentialInput,
): Promise<CredentialMeta> {
  if (!master) throw new VaultOffError();
  const secret = checkSecret(input.secret);
  const slot = checkSlot(input, secret);
  const tenant = await tenantOf(tx);

  const sealed = await sealSecret(master, secret, credentialContext({ ...tenant, ...slot }));
  const values = { ...sealed, last4: last4(secret), validatedAt: input.validatedAt ?? null };
  const [row] = await tx
    .insert(credentials)
    .values({ workspaceId: tenant.workspaceId, ...slot, ...values })
    .onConflictDoUpdate({
      target: [credentials.workspaceId, credentials.provider, credentials.label],
      set: values,
    })
    // xmax is 0 only on a row this statement inserted, not one it updated.
    .returning({ ...metadata, inserted: sql<boolean>`xmax = 0` });
  if (!row) throw new Error("putCredential: the upsert returned no row.");

  const { inserted, ...stored } = row;
  await recordAudit(tx, tenant, inserted ? "credential.stored" : "credential.replaced", stored);
  return stored;
}

/** Every key in the workspace, as metadata. Its query never selects an envelope column. */
export async function listCredentials<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<CredentialMeta[]> {
  const { workspaceId } = await tenantOf(tx);
  return tx
    .select(metadata)
    .from(credentials)
    .where(eq(credentials.workspaceId, workspaceId))
    .orderBy(asc(credentials.provider), asc(credentials.label));
}

/**
 * The plaintext key in a slot, or null if the slot is empty. For server-side provider calls
 * only: never put the result in a response or a log line.
 *
 * Throws VaultOffError while the vault is off, and VaultOpenError if the row doesn't open.
 */
export async function revealCredential<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  master: CryptoKey | null,
  slot: CredentialSlot,
): Promise<string | null> {
  if (!master) throw new VaultOffError();
  const { provider, label } = checkSlot(slot);
  const { workspaceId } = await tenantOf(tx);
  const [row] = await tx
    .select({
      workspaceId: credentials.workspaceId,
      provider: credentials.provider,
      label: credentials.label,
      ciphertext: credentials.ciphertext,
      iv: credentials.iv,
      wrappedDek: credentials.wrappedDek,
      dekIv: credentials.dekIv,
    })
    .from(credentials)
    .where(slotIs(workspaceId, provider, label))
    .limit(1);
  if (!row) return null;
  try {
    // The context comes from the row's own columns, so a row moved elsewhere fails here.
    return await openSecret(master, sealedOf(row), credentialContext(row));
  } catch (error) {
    throw new VaultOpenError({ cause: error });
  }
}

/**
 * Empties a slot and records `credential.deleted`. Returns false, and records nothing, if the
 * slot was already empty. Needs no master key, so users can remove keys while the vault is off.
 */
export async function deleteCredential<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>, slot: CredentialSlot): Promise<boolean> {
  const { provider, label } = checkSlot(slot);
  const tenant = await tenantOf(tx);
  const [row] = await tx
    .delete(credentials)
    .where(slotIs(tenant.workspaceId, provider, label))
    .returning(metadata);
  if (!row) return false;
  await recordAudit(tx, tenant, "credential.deleted", row);
  return true;
}

/** Copies a row's envelope into the ArrayBuffer-backed bytes WebCrypto's types ask for. */
export function sealedOf(row: {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly dekIv: Uint8Array;
}): SealedSecret {
  return {
    ciphertext: new Uint8Array(row.ciphertext),
    iv: new Uint8Array(row.iv),
    wrappedDek: new Uint8Array(row.wrappedDek),
    dekIv: new Uint8Array(row.dekIv),
  };
}

type Tenant = { readonly userId: string; readonly workspaceId: string };

/**
 * The user and workspace withTenant set on this transaction. Throws unless it runs as the tenant
 * role with both set: on the owner connection RLS doesn't apply, and these functions would reach
 * every workspace's keys.
 */
async function tenantOf<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(tx: PgTransaction<TQueryResult, TFullSchema, TSchema>): Promise<Tenant> {
  const result: unknown = await tx.execute(
    sql`select current_user as role, current_setting('app.user_id', true) as user_id,
               current_setting('app.workspace_id', true) as workspace_id`,
  );
  // PGlite and node-postgres-style drivers return { rows }; postgres.js returns the rows.
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  const row = rows?.[0] as
    | Partial<Record<"role" | "user_id" | "workspace_id", unknown>>
    | undefined;
  const userId = row?.user_id;
  const workspaceId = row?.workspace_id;
  if (
    row?.role !== TENANT_ROLE ||
    typeof userId !== "string" ||
    typeof workspaceId !== "string" ||
    !userId ||
    !workspaceId
  ) {
    throw new TypeError("Vault functions must run in a transaction from withTenant.");
  }
  return { userId, workspaceId };
}

function slotIs(workspaceId: string, provider: string, label: string) {
  // RLS already limits the rows to the workspace; the filter keeps the query explicit.
  return and(
    eq(credentials.workspaceId, workspaceId),
    eq(credentials.provider, provider),
    eq(credentials.label, label),
  );
}

// Validation errors never quote the input: a key pasted into the wrong field would end up in
// an error message, and from there in a log.
function checkSlot(slot: CredentialSlot, secret?: string): { provider: ProviderId; label: string } {
  if (typeof slot.provider !== "string" || !isProviderId(slot.provider)) {
    throw new TypeError("Unknown provider.");
  }
  const label = typeof slot.label === "string" ? slot.label.trim() : DEFAULT_LABEL;
  if (!label || label.length > MAX_LABEL_LENGTH || /\p{Cc}/u.test(label)) {
    throw new TypeError(`A label must be 1 to ${MAX_LABEL_LENGTH} printable characters.`);
  }
  // Labels are stored, listed, and audited in plain text, so one can't hold a key: not the key
  // being stored, nor anything shaped like a provider key.
  if (redact(label, secret === undefined ? [] : [secret]) !== label) {
    throw new TypeError("A label can't contain a key.");
  }
  return { provider: slot.provider, label };
}

function checkSecret(secret: unknown): string {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (!value || value.length > MAX_SECRET_LENGTH) {
    throw new TypeError(`A key must be 1 to ${MAX_SECRET_LENGTH} characters long.`);
  }
  return value;
}

async function recordAudit<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  { userId, workspaceId }: Tenant,
  action: "credential.stored" | "credential.replaced" | "credential.deleted",
  credential: Pick<CredentialMeta, "id" | "provider" | "label" | "last4">,
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId,
    actorUserId: userId,
    action,
    subjectType: "credential",
    subjectId: credential.id,
    detail: { provider: credential.provider, label: credential.label, last4: credential.last4 },
  });
}
