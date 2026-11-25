// What the entity linker reads besides the index (ADR-0028): the record kinds each proposal type
// can target, the mention as the linker reads it, and the session's earlier links. The
// understanding step (./understand.ts) and the second witness (./witness.ts) use them in SessionDO;
// the web app's inbox imports this file alone (`@earshot/agent/link-context`) to re-link a
// new-record proposal at review time with the same context (Phase 5 WP12), without the extractor,
// its adapters, or the AI SDK. Pure, and types aside it imports only the name toolkit.
import type { EntityKind, ProposalTypeV2, TargetV2 } from "@earshot/core";
import type { MentionInput } from "@earshot/understanding/link";
import { foldName } from "@earshot/understanding/names";

/**
 * The record kinds each proposal type can target. A contact proposal updates a contact and a deal
 * update changes a deal; notes, tasks, commitments, and meetings can hang off any record.
 */
export const TARGET_KINDS: Readonly<Record<ProposalTypeV2, readonly EntityKind[]>> = {
  note: ["company", "contact", "deal"],
  task: ["company", "contact", "deal"],
  contact: ["contact"],
  deal_update: ["deal"],
  commitment: ["company", "contact", "deal"],
  meeting: ["company", "contact", "deal"],
};

/** How many earlier links SessionDO keeps for the linker's `recent` feature (spec WP8 step 4). */
export const MAX_RECENT_LINKS = 20;

/**
 * The mention as the linker reads it. A contact is read with the company said beside it, which
 * the linker's `parentCtx` weighs. A deal is indexed the way it's said, its company then the rest
 * of its name ("Atmos onboarding package", ADR-0028), and linker v1 was fit on deal mentions in
 * that form with no separate company. So a deal whose company the rep said apart from the rest
 * ("Pier Logistics … the expansion") is read as the two together, company first; one whose words
 * already hold its company is read as quoted; and neither carries the company on the side. The
 * target's `mention` and `company` keep the quotes either way.
 */
export function linkerMention(
  text: string,
  kind: MentionInput["kind"],
  companyText: string | null | undefined,
): MentionInput {
  if (kind !== "deal") return { text, kind, companyText: companyText ?? null };
  const company = companyText ? foldName(companyText) : "";
  if (company === "" || ` ${foldName(text)} `.includes(` ${company} `)) {
    return { text, kind, companyText: null };
  }
  return { text: `${companyText} ${text}`, kind, companyText: null };
}

/**
 * The mention a proposal's target linker read: the target's quote (a contact's `name`), with the
 * company said beside it, read as the understanding step reads them. Null for a target with no
 * words.
 */
export function linkedMention(target: TargetV2): MentionInput | null {
  if (target.mention === null) return null;
  return linkerMention(target.mention.quote, target.kind, target.company?.quote ?? null);
}

/**
 * The session's earlier links after a turn: each record the turn's proposals linked from words
 * that were said, and each company linked beside them, most recent first, without repeats, at most
 * `MAX_RECENT_LINKS`. An implied target isn't one: nothing named it.
 */
export function withRecentLinks(
  recent: readonly string[],
  proposals: readonly { readonly target: TargetV2 }[],
): string[] {
  const out = [...recent];
  for (const { target } of proposals) {
    const linked = [
      target.company?.entityId ?? null,
      target.decision === "linked" && target.basis !== "focus" ? target.entityId : null,
    ];
    for (const id of linked) {
      if (id === null) continue;
      const at = out.indexOf(id);
      if (at >= 0) out.splice(at, 1);
      out.unshift(id);
    }
  }
  return out.slice(0, MAX_RECENT_LINKS);
}
