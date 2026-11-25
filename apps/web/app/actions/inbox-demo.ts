"use server";

// The inbox's demo controls (Phase 5 spec WP12 step 4; ADR-0035): "Simulate a CRM change" and "Add
// a matching record", in the More menu of cards whose record is a demo record. Each takes only the
// card's ids and decides everything else from the database, in the viewer's tenant transaction:
// the debrief must be the viewer's own, and the data layer (`moveDemoField`, `addDemoRecord`) acts
// only on the workspace's demo records, so neither can reach a record from a CRM connection, a row
// without the demo prefix, or another workspace's. The page reads the inbox again afterwards.
import { addDemoRecord, moveDemoField, schema } from "@earshot/db";
import { and, eq } from "drizzle-orm";
import { log } from "@/lib/auth";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";
import { shownValue } from "@/lib/inbox/copy";
import { UPDATE_FIELDS } from "@/lib/inbox/crm";
import { proposalFromRow } from "@/lib/inbox/load";

export type InboxDemoResult = { status: "done" | "nothing" | "error"; message: string };

/** What each control takes: the card's debrief and proposal. */
export type InboxDemoInput = { sessionId: string; proposalId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids, checked: a server action is callable with anything. */
function readInput(input: unknown): InboxDemoInput | null {
  if (typeof input !== "object" || input === null) return null;
  const { sessionId, proposalId } = input as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof proposalId !== "string") return null;
  if (!UUID.test(sessionId) || !UUID.test(proposalId)) return null;
  return { sessionId: sessionId.toLowerCase(), proposalId: proposalId.toLowerCase() };
}

const NOTHING: InboxDemoResult = {
  status: "nothing",
  message: "That card has nothing in the demo CRM to change.",
};

/** The proposal, if its debrief is the viewer's own; null otherwise, as if it weren't there. */
async function ownProposal(
  tx: Parameters<Parameters<typeof withViewerTenant>[0]>[0],
  viewer: Awaited<ReturnType<typeof requireViewer>>,
  input: InboxDemoInput,
) {
  const { proposals, sessions } = schema;
  const [session] = await tx
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, viewer.workspaceId), eq(sessions.id, input.sessionId)))
    .limit(1);
  if (!session || session.userId !== viewer.user.id) return null;
  const [row] = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, viewer.workspaceId),
        eq(proposals.sessionId, input.sessionId),
        eq(proposals.id, input.proposalId),
      ),
    )
    .limit(1);
  return row ? proposalFromRow(row) : null;
}

/**
 * "Simulate a CRM change": moves one field of the card's record in the demo CRM, with its history,
 * in one transaction. The field is the first of the update's fields (a deal's stage, amount, close
 * date; a contact's title, email, phone) that the record holds a value to move from, so the card
 * shows three values once the inbox reads it again.
 */
export async function simulateCrmChangeAction(input: InboxDemoInput): Promise<InboxDemoResult> {
  // Outside the try: a missing session redirects to sign-in, which must not be caught.
  const viewer = await requireViewer("/inbox");
  const ids = readInput(input);
  if (!ids) return NOTHING;
  try {
    const moved = await withViewerTenant(async (tx) => {
      const proposal = await ownProposal(tx, viewer, ids);
      if (proposal?.status !== "proposed") return null;
      const { target } = proposal;
      if (target.decision !== "linked" || !target.entityId) return null;
      const now = new Date();
      for (const field of UPDATE_FIELDS[proposal.type] ?? []) {
        if (!(field in proposal.fields)) continue;
        const change = await moveDemoField(tx, { entityId: target.entityId, field, now });
        if (change) return change;
      }
      return null;
    }, viewer);
    if (!moved) return NOTHING;
    log.info("demo CRM changed", { field: moved.field });
    return {
      status: "done",
      message: `Changed the ${moved.field === "closeDate" ? "close date" : moved.field} in the demo CRM to ${shownValue(moved.field, moved.new)}.`,
    };
  } catch (error) {
    log.error("demo CRM change failed", { error });
    return { status: "error", message: "The demo CRM didn't change. Try again." };
  }
}

/**
 * "Add a matching record": adds the company or contact a new-record card heard to the demo CRM,
 * named as it was said (a contact with the company said beside it, when that's a demo company), so
 * the card offers it once the inbox reads it again.
 */
export async function addMatchingRecordAction(input: InboxDemoInput): Promise<InboxDemoResult> {
  const viewer = await requireViewer("/inbox");
  const ids = readInput(input);
  if (!ids) return NOTHING;
  try {
    const added = await withViewerTenant(async (tx) => {
      const proposal = await ownProposal(tx, viewer, ids);
      if (proposal?.status !== "proposed") return null;
      const { target } = proposal;
      if (target.decision !== "new" || !target.mention) return null;
      if (target.kind !== "company" && target.kind !== "contact") return null;
      return addDemoRecord(tx, {
        kind: target.kind,
        name: target.mention.quote,
        companyEntityId: target.company?.entityId ?? null,
        newId: () => crypto.randomUUID(),
        now: new Date(),
      });
    }, viewer);
    if (!added) return NOTHING;
    log.info("demo CRM record added", { kind: added.kind, added: added.added });
    return {
      status: "done",
      message: added.added
        ? `Added ${added.name} to the demo CRM.`
        : `${added.name} is already in the demo CRM.`,
    };
  } catch (error) {
    log.error("demo CRM record add failed", { error });
    return { status: "error", message: "The demo CRM didn't change. Try again." };
  }
}
