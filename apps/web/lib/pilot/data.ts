// What /pilot shows (Phase 5 spec WP7 step 2; ADR-0039): pilot.v1's sessions as the inbox holds
// debriefs, built once at build time from the set's logs, its manifest, and the demo CRM, so the
// page ships plain data and needs no database, account, or server. Pure: the page runs it while
// it's prerendered, and the tests run it on the committed files.
import type { EventEnvelope, FieldValue } from "@earshot/core";
import { defaultProjections, fromJsonl, type ProposalView, replay } from "@earshot/events";
import type { InboxEntity, InboxProposal, InboxSession } from "@/lib/inbox/types";

/** One session's entry in pilot.v1's manifest, as the page reads it. */
export interface PilotManifestSession {
  readonly id: string;
  readonly script: string;
  readonly file: string;
  readonly sessionId: string;
  readonly focusEntityId: string | null;
  readonly callTime: string;
  readonly timeZone: string;
  readonly proposals: readonly string[];
}

/**
 * The parts of pilot.v1's manifest the page reads. The whole shape is `PilotManifest` in
 * `@earshot/evals/pilot`, which a test holds this to.
 */
export interface PilotManifestLike {
  readonly set: string;
  readonly sha256: string;
  readonly sessions: readonly PilotManifestSession[];
  readonly practice: PilotManifestSession;
  readonly orders: Readonly<Record<string, readonly string[]>>;
}

/** The demo CRM's records, as `@earshot/demo-crm` exports them. */
export interface DemoCrmLike {
  readonly companies: readonly { readonly id: string; readonly name: string }[];
  readonly contacts: readonly {
    readonly id: string;
    readonly companyId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly title: string;
    readonly email: string;
    readonly phone: string;
  }[];
  readonly deals: readonly {
    readonly id: string;
    readonly companyId: string;
    readonly name: string;
    readonly stage: string;
    readonly amount: number;
    readonly closeDate: string;
  }[];
}

/** One of the set's sessions, as the page shows it. */
export interface PilotSession {
  /** `s01` to `s10`, or `practice`. */
  readonly id: string;
  /** The debrief, as the inbox's review list takes it: sealed, with its proposals folded. */
  readonly session: InboxSession;
  /** When the call was, in the rep's own time zone: what "tomorrow" on its cards counts from. */
  readonly when: string;
}

export interface PilotData {
  readonly set: string;
  readonly setSha256: string;
  /** `s01` to `s10`, in the set's order; each participant sees them in their own (`orders`). */
  readonly sessions: readonly PilotSession[];
  readonly practice: PilotSession;
  readonly orders: Readonly<Record<string, readonly string[]>>;
  /** The records the cards name, by id, as the inbox's loader reads them from a CRM mirror. */
  readonly entities: Readonly<Record<string, InboxEntity>>;
  /** The texts of the utterances the cards quote, by utterance id. */
  readonly quotes: Readonly<Record<string, string>>;
}

/** A proposal as the inbox holds it: its latest review trimmed to what the cards read. */
export function inboxProposal(view: ProposalView): InboxProposal {
  const { review } = view;
  return {
    ...view,
    review: review
      ? {
          reviewId: review.reviewId,
          decision: review.decision,
          target: review.target,
          mode: review.mode,
          batchId: review.batchId,
          undoes: review.undoes,
          syncEligibleAt: review.syncEligibleAt,
          ts: review.ts,
        }
      : null,
  };
}

/** "Wednesday, November 18 at 10:45 AM", in the rep's time zone. */
export function callWhen(callTime: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(callTime));
}

/** Every record id and utterance id a session's cards point at. */
function referenced(proposals: readonly ProposalView[], into: Set<string>, quotes: Set<string>) {
  for (const proposal of proposals) {
    const { target } = proposal;
    if (target.entityId) into.add(target.entityId);
    if (target.company?.entityId) into.add(target.company.entityId);
    for (const candidate of target.candidates) if (candidate.entityId) into.add(candidate.entityId);
    if (target.mention) quotes.add(target.mention.evidence.utteranceId);
    if (target.company) quotes.add(target.company.evidence.utteranceId);
    for (const field of Object.values(proposal.fields)) quotes.add(field.evidence.utteranceId);
    for (const conflict of proposal.conflicts) quotes.add(conflict.biased.evidence.utteranceId);
  }
}

/** The demo CRM's records as the inbox's loader reads them: each with its account and values. */
function crmEntities(crm: DemoCrmLike): Map<string, InboxEntity> {
  const entities = new Map<string, InboxEntity>();
  const companyIds = new Set(crm.companies.map((company) => company.id));
  const account = (companyId: string) => (companyIds.has(companyId) ? companyId : null);
  for (const company of crm.companies) {
    entities.set(company.id, {
      id: company.id,
      kind: "company",
      name: company.name,
      accountId: company.id,
      values: {},
    });
  }
  for (const contact of crm.contacts) {
    const values: Record<string, FieldValue> = {
      title: contact.title,
      email: contact.email,
      phone: contact.phone,
    };
    entities.set(contact.id, {
      id: contact.id,
      kind: "contact",
      name: `${contact.firstName} ${contact.lastName}`,
      accountId: account(contact.companyId),
      values,
    });
  }
  for (const deal of crm.deals) {
    const values: Record<string, FieldValue> = {
      stage: deal.stage,
      amount: deal.amount,
      closeDate: deal.closeDate,
    };
    entities.set(deal.id, {
      id: deal.id,
      kind: "deal",
      name: deal.name,
      accountId: account(deal.companyId),
      values,
    });
  }
  return entities;
}

/**
 * pilot.v1 as the page shows it: each log read and replayed with the projections production uses,
 * its proposals as the inbox holds them, the records they name (with their accounts), and the
 * words they quote. Throws if a log doesn't replay, isn't sealed, or disagrees with the manifest.
 */
export function buildPilotData(input: {
  readonly manifest: PilotManifestLike;
  /** Each session's JSONL, by its file name. */
  readonly logs: Readonly<Record<string, string>>;
  readonly crm: DemoCrmLike;
}): PilotData {
  const { manifest } = input;
  const all = crmEntities(input.crm);
  const wanted = new Set<string>();
  const quoted = new Set<string>();
  const texts = new Map<string, string>();

  const build = (entry: PilotManifestSession): PilotSession => {
    const text = input.logs[entry.file];
    if (text === undefined) throw new Error(`pilot.v1 has no ${entry.file}`);
    const events: EventEnvelope[] = fromJsonl(text);
    const { session, proposals } = replay(events, defaultProjections);
    if (!session || session.sealedAt === null || session.endedAt === null) {
      throw new Error(`${entry.file} isn't a sealed session`);
    }
    if (session.sessionId !== entry.sessionId) {
      throw new Error(`${entry.file} isn't session ${entry.sessionId}`);
    }
    const ids = proposals.map((proposal) => proposal.proposalId);
    if (ids.join(" ") !== entry.proposals.join(" ")) {
      throw new Error(`${entry.file}'s proposals aren't the manifest's`);
    }
    for (const event of events) {
      if (event.type !== "utterance.final") continue;
      const payload = event.payload as { utteranceId: string; text: string };
      texts.set(payload.utteranceId, payload.text);
    }
    referenced(proposals, wanted, quoted);
    if (entry.focusEntityId) wanted.add(entry.focusEntityId);
    return {
      id: entry.id,
      session: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        sealedAt: session.sealedAt,
        focusEntityId: entry.focusEntityId,
        proposals: proposals.map(inboxProposal),
      },
      when: callWhen(entry.callTime, entry.timeZone),
    };
  };

  const sessions = manifest.sessions.map(build);
  const practice = build(manifest.practice);

  // The records the cards name, and the companies those belong to (the account headings).
  const entities: Record<string, InboxEntity> = {};
  const add = (id: string) => {
    const entity = all.get(id);
    if (!entity || entities[id]) return;
    entities[id] = entity;
    if (entity.accountId && entity.accountId !== id) add(entity.accountId);
  };
  for (const id of [...wanted].sort()) add(id);
  const quotes: Record<string, string> = {};
  for (const id of [...quoted].sort()) {
    const quote = texts.get(id);
    if (quote !== undefined) quotes[id] = quote;
  }
  return {
    set: manifest.set,
    setSha256: manifest.sha256,
    sessions,
    practice,
    orders: manifest.orders,
    entities,
    quotes,
  };
}
