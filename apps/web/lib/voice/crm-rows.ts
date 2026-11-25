// The workspace's CRM rows a session can draw on, as `POST /api/sessions` reads them to rank its
// entities (./keyterms.ts) and the inbox's loader reads them to re-link a new-record proposal at
// review time with the records a session would start with now (Phase 5 WP12). Inside the viewer's
// tenant transaction, so row-level security confines the reads to the workspace.
import { type EntityKind, MAX_SESSION_ENTITIES } from "@earshot/core";
import { DEMO_CRM_EXTERNAL_ID_PREFIX, schema } from "@earshot/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../auth/viewer";
import type { CrmEntity } from "./keyterms";

/** The CRM rows read per kind: as many as `start` can carry in all. */
const CRM_ROWS_PER_KIND = MAX_SESSION_ENTITIES;
/** The selected account's contacts and deals read, at most. */
const ACCOUNT_ROWS = 2 * MAX_SESSION_ENTITIES;
const ENTITY_KINDS: readonly EntityKind[] = ["company", "contact", "deal"];

/**
 * The workspace's CRM rows a session can draw on: the most recently updated 250 of each kind,
 * plus the selected account and up to 500 of its contacts and deals, whatever their age. Only
 * the columns ranking needs: never the embedding, and of the properties only `companyId`.
 */
export async function loadCrmEntities(
  tx: TenantTx,
  workspaceId: string,
  selectedAccountId: string | null | undefined,
): Promise<CrmEntity[]> {
  const { crmEntities } = schema;
  const companyId = sql<string | null>`${crmEntities.properties} ->> 'companyId'`;
  const columns = {
    id: crmEntities.id,
    kind: crmEntities.kind,
    name: crmEntities.name,
    aliases: crmEntities.aliases,
    connectionId: crmEntities.connectionId,
    externalId: crmEntities.externalId,
    companyId,
    updatedAt: crmEntities.updatedAt,
  };
  // Row-level security already confines the reads to the workspace; the filter keeps them explicit.
  const inWorkspace = eq(crmEntities.workspaceId, workspaceId);
  const byRecency = [desc(crmEntities.updatedAt), asc(crmEntities.id)] as const;

  const rows: CrmEntityRow[] = [];
  for (const kind of ENTITY_KINDS) {
    rows.push(
      ...(await tx
        .select(columns)
        .from(crmEntities)
        .where(and(inWorkspace, eq(crmEntities.kind, kind)))
        .orderBy(...byRecency)
        .limit(CRM_ROWS_PER_KIND)),
    );
  }
  if (selectedAccountId) {
    const [account] = await tx
      .select(columns)
      .from(crmEntities)
      .where(
        and(inWorkspace, eq(crmEntities.id, selectedAccountId), eq(crmEntities.kind, "company")),
      )
      .limit(1);
    if (account) {
      rows.push(account);
      rows.push(
        ...(await tx
          .select(columns)
          .from(crmEntities)
          .where(
            and(
              inWorkspace,
              inArray(crmEntities.kind, ["contact", "deal"]),
              account.connectionId === null
                ? isNull(crmEntities.connectionId)
                : eq(crmEntities.connectionId, account.connectionId),
              sql`${companyId} = ${sourceIdOf(account)}`,
            ),
          )
          .orderBy(...byRecency)
          .limit(ACCOUNT_ROWS)),
      );
    }
  }
  return rows.flatMap(({ kind, externalId, ...row }): CrmEntity[] =>
    isEntityKind(kind)
      ? [{ ...row, kind, sourceId: sourceIdOf({ connectionId: row.connectionId, externalId }) }]
      : [],
  );
}

type CrmEntityRow = Omit<CrmEntity, "kind" | "sourceId"> & { kind: string; externalId: string };

/**
 * A row's id in its source CRM, which its contacts and deals name as `companyId`. The demo CRM's
 * rows carry their dataset ids behind a `demo:` prefix (packages/db/src/demo-crm.ts).
 */
export function sourceIdOf(row: { connectionId: string | null; externalId: string }): string {
  return row.connectionId === null && row.externalId.startsWith(DEMO_CRM_EXTERNAL_ID_PREFIX)
    ? row.externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length)
    : row.externalId;
}

function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}
