// Re-linking a new-record proposal at review time (Phase 5 spec WP12 step 5, decision 10, §4.4;
// ADR-0035). Most proposals create records, and their version of a conflict is a duplicate: a
// record that reached the CRM after the rep spoke, under the name they said. So for proposals still
// waiting as new records, the inbox's loader runs the entity linker again, over the mirror as it is
// now, with the context SessionDO's linker had: the session's focus account, the records linked
// earlier in the session, and the kinds the proposal's type allows. If it links now, to a record
// whose arrival the mirror's history dates after the proposal, the card offers it, loud.
//
// Pure; the loader (./load.ts) reads the mirror and the history. It imports only the linker and its
// context (`@earshot/understanding/link`, `@earshot/agent/link-context`), never the extractor.
import { linkedMention, TARGET_KINDS, withRecentLinks } from "@earshot/agent/link-context";
import {
  buildLinkIndex,
  LINKER_PARAMS_V1,
  type LinkEntity,
  type LinkIndex,
  link,
} from "@earshot/understanding/link";
import { parentIds, toEntityRef } from "../voice/entities";
import type { CrmEntity } from "../voice/keyterms";
import type { InboxProposal } from "./types";

/**
 * Whether a re-link offer may be made on a proposal: still open, not replaced, a new record, and
 * named by words the linker can read again.
 */
export function canRelink(proposal: InboxProposal): boolean {
  return (
    proposal.status === "proposed" &&
    proposal.supersededBy === null &&
    proposal.target.decision === "new" &&
    proposal.target.mention !== null
  );
}

/**
 * The records linked before `proposal` in its session, most recent first: what SessionDO's linker
 * had as `recent` when it made the proposal, from the session's proposals as they stand.
 */
export function earlierLinks(
  proposal: Pick<InboxProposal, "seq">,
  sessionProposals: readonly Pick<InboxProposal, "seq" | "target">[],
): string[] {
  const before = sessionProposals
    .filter((other) => other.seq < proposal.seq)
    .sort((a, b) => a.seq - b.seq);
  return withRecentLinks([], before);
}

/**
 * The mirror as the linker's index: each row as a session's `start` would carry it (its name and
 * aliases cleaned, key-shaped names dropped, contacts and deals with their company), and every row
 * the reads returned, not only the 250 a session's `start` can hold.
 */
export function mirrorIndex(rows: readonly CrmEntity[]): LinkIndex {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const parents = parentIds(unique);
  const entities: LinkEntity[] = unique.flatMap((row) => {
    const ref = toEntityRef(row, parents.get(row.id));
    return ref ? [ref] : [];
  });
  return buildLinkIndex(entities);
}

/**
 * The record a new-record proposal's words link to now, over `index`, or null when the linker
 * asks, proposes a new record again, or finds nothing. The focus account counts only if the index
 * holds it, as a session's `start` refuses a focus outside its records.
 */
export function relinkTarget(
  proposal: Pick<InboxProposal, "type" | "target">,
  context: {
    readonly index: LinkIndex;
    readonly focusEntityId: string | null;
    readonly recent: readonly string[];
  },
): string | null {
  const mention = linkedMention(proposal.target);
  if (mention === null) return null;
  const { index, focusEntityId, recent } = context;
  const result = link(mention, {
    index,
    focusEntityId: focusEntityId !== null && index.byId.has(focusEntityId) ? focusEntityId : null,
    recent,
    turnMentions: [],
    kinds: TARGET_KINDS[proposal.type],
    params: LINKER_PARAMS_V1,
  });
  return result.decision === "linked" ? result.entityId : null;
}
