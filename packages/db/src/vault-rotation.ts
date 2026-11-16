// Master-key rotation for the vault (docs/vault-key-rotation.md). Every data key in
// `credentials` and `crm_connections`, across all workspaces, is unwrapped with the old master
// key and wrapped with the new one, in one transaction on the owner connection. Ciphertexts
// never change and are never decrypted: only `wrapped_dek` and `dek_iv` are rewritten.
import { rewrapSecret, type SealedSecret, sameMasterKey } from "@earshot/keys/server";
import { asc, eq, sql, type TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { auditLog, credentials, crmConnections } from "./schema";
import { credentialContext, crmConnectionContext, sealedOf } from "./vault";

export interface RotationReport {
  readonly dryRun: boolean;
  /** Rows re-wrapped, or that would be in a dry run. */
  readonly credentials: number;
  readonly crmConnections: number;
  /** Workspaces holding any of those rows. Each gets one `credential.rotated` audit entry. */
  readonly workspaces: number;
}

/** Some rows didn't open with the old key, so nothing was changed. Carries counts only. */
export class VaultRotationError extends Error {
  readonly credentials: number;
  readonly crmConnections: number;

  constructor(failed: { credentials: number; crmConnections: number }) {
    super(
      `${failed.credentials} credential(s) and ${failed.crmConnections} CRM connection(s) don't open with the old master key; nothing was changed.`,
    );
    this.name = "VaultRotationError";
    this.credentials = failed.credentials;
    this.crmConnections = failed.crmConnections;
  }
}

/**
 * Re-wraps every vault data key under `newMaster`. Run it on the owner connection: it reads and
 * writes every workspace's rows, and writes one system audit entry (no actor) per workspace it
 * touched, with counts only.
 *
 * All or nothing: if any row's data key doesn't unwrap with `oldMaster` under its row's context,
 * it throws VaultRotationError before writing anything. It refuses when the two keys are the
 * same key. The tables are locked against writes until it commits, so no row can change under
 * it. A dry run does the same checks in a read-only transaction and writes nothing.
 */
export async function rotateVaultKey<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  ownerDb: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  oldMaster: CryptoKey,
  newMaster: CryptoKey,
  options: { readonly dryRun?: boolean } = {},
): Promise<RotationReport> {
  const dryRun = options.dryRun ?? false;
  if (await sameMasterKey(oldMaster, newMaster)) {
    throw new TypeError("The old and new master keys are the same key; nothing was changed.");
  }

  return ownerDb.transaction(
    async (tx) => {
      if (!dryRun) {
        // Writers wait until this commits, so none can add or re-seal a row mid-rotation.
        await tx.execute(
          sql`lock table ${credentials}, ${crmConnections} in share row exclusive mode`,
        );
      }
      const credentialRows = await tx
        .select({
          id: credentials.id,
          workspaceId: credentials.workspaceId,
          provider: credentials.provider,
          label: credentials.label,
          ciphertext: credentials.ciphertext,
          iv: credentials.iv,
          wrappedDek: credentials.wrappedDek,
          dekIv: credentials.dekIv,
        })
        .from(credentials)
        .orderBy(asc(credentials.id));
      const connectionRows = await tx
        .select({
          id: crmConnections.id,
          workspaceId: crmConnections.workspaceId,
          provider: crmConnections.provider,
          ciphertext: crmConnections.ciphertext,
          iv: crmConnections.iv,
          wrappedDek: crmConnections.wrappedDek,
          dekIv: crmConnections.dekIv,
        })
        .from(crmConnections)
        .orderBy(asc(crmConnections.id));

      // Re-wrap everything in memory first; write only if every row opened.
      const rewrappedCredentials = await rewrapAll(
        credentialRows,
        credentialContext,
        oldMaster,
        newMaster,
      );
      const rewrappedConnections = await rewrapAll(
        connectionRows,
        crmConnectionContext,
        oldMaster,
        newMaster,
      );
      if (rewrappedCredentials.failed > 0 || rewrappedConnections.failed > 0) {
        throw new VaultRotationError({
          credentials: rewrappedCredentials.failed,
          crmConnections: rewrappedConnections.failed,
        });
      }

      const perWorkspace = new Map<string, { credentials: number; crmConnections: number }>();
      const countFor = (workspaceId: string) => {
        const counts = perWorkspace.get(workspaceId) ?? { credentials: 0, crmConnections: 0 };
        perWorkspace.set(workspaceId, counts);
        return counts;
      };
      for (const row of credentialRows) countFor(row.workspaceId).credentials++;
      for (const row of connectionRows) countFor(row.workspaceId).crmConnections++;

      if (!dryRun) {
        for (const { id, wrappedDek, dekIv } of rewrappedCredentials.rows) {
          await tx.update(credentials).set({ wrappedDek, dekIv }).where(eq(credentials.id, id));
        }
        for (const { id, wrappedDek, dekIv } of rewrappedConnections.rows) {
          await tx
            .update(crmConnections)
            .set({ wrappedDek, dekIv })
            .where(eq(crmConnections.id, id));
        }
        if (perWorkspace.size > 0) {
          await tx.insert(auditLog).values(
            [...perWorkspace].map(([workspaceId, counts]) => ({
              workspaceId,
              actorUserId: null,
              action: "credential.rotated",
              detail: counts,
            })),
          );
        }
      }

      return {
        dryRun,
        credentials: credentialRows.length,
        crmConnections: connectionRows.length,
        workspaces: perWorkspace.size,
      };
    },
    // A dry run can't write even by mistake: Postgres refuses writes in a read-only transaction.
    dryRun ? { accessMode: "read only" } : undefined,
  );
}

type EnvelopeRow = {
  readonly id: string;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly dekIv: Uint8Array;
};

/** A row's new wrapping: the only columns a rotation writes. */
type Rewrapped = Pick<SealedSecret, "wrappedDek" | "dekIv"> & { readonly id: string };

async function rewrapAll<Row extends EnvelopeRow>(
  rows: readonly Row[],
  contextOf: (row: Row) => string,
  oldMaster: CryptoKey,
  newMaster: CryptoKey,
): Promise<{ rows: Rewrapped[]; failed: number }> {
  const rewrapped: Rewrapped[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      const { wrappedDek, dekIv } = await rewrapSecret(
        oldMaster,
        newMaster,
        sealedOf(row),
        contextOf(row),
      );
      rewrapped.push({ id: row.id, wrappedDek, dekIv });
    } catch {
      // A wrong old key, or a row moved or tampered with. Counted, never logged.
      failed++;
    }
  }
  return { rows: rewrapped, failed };
}
