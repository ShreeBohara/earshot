// How the inbox arranges what the loader read (Phase 5 spec WP5 step 2). Pure: the page runs it on
// every render, after its own reviews have moved cards, and the tests run it on fixtures.
//
// - **Sections:** needs review, finishing, reviewed, snoozed.
// - **Groups:** one per debrief in "needs review", headed by its account (the focus account, else
//   the account its proposals name most) and its time.
// - **Accounts:** a sub-heading per account when a debrief's open cards name more than one.
//
// A sealed debrief's proposals are reviewable; an unsealed one's wait under "Finishing" until
// `session.sealed` reaches Postgres. Superseded proposals appear nowhere: their correction does.
import type { InboxEntity, InboxProposal, InboxSession } from "./types";

type Entities = Readonly<Record<string, InboxEntity>>;

/** A proposal that waits for a decision now: proposed, and not snoozed past `now`. */
export function isOpen(proposal: InboxProposal, now: number): boolean {
  return proposal.status === "proposed" && !isSnoozed(proposal, now);
}

/** A proposal set aside until a time still to come. */
export function isSnoozed(proposal: InboxProposal, now: number): boolean {
  return (
    proposal.status === "proposed" &&
    proposal.snoozedUntil !== null &&
    Date.parse(proposal.snoozedUntil) > now
  );
}

/** A proposal someone decided: accepted, edited, or rejected. */
export function isDecided(proposal: InboxProposal): boolean {
  return (
    proposal.status === "approved" || proposal.status === "edited" || proposal.status === "rejected"
  );
}

function accountOfEntity(entities: Entities, id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return entities[id]?.accountId ?? null;
}

/**
 * The account a proposal is about: its record's company (a company is its own), or for a question
 * the one company every candidate belongs to; otherwise the company said with the record, if it
 * was linked. Null when nothing says.
 */
export function accountOf(proposal: InboxProposal, entities: Entities): string | null {
  const { target } = proposal;
  const said = accountOfEntity(entities, target.company?.entityId);
  switch (target.decision) {
    case "linked":
      return accountOfEntity(entities, target.entityId) ?? said;
    case "ask": {
      const records = target.candidates.filter((candidate) => candidate.entityId !== null);
      const accounts = new Set(
        records.map((candidate) => accountOfEntity(entities, candidate.entityId)),
      );
      const [only] = accounts;
      return accounts.size === 1 && only ? only : said;
    }
    case "new":
    case "none":
      return said;
  }
}

/**
 * The account a debrief is headed by: the account open when it started, else the one its
 * proposals name most (the first named, on a tie), else none.
 */
export function sessionAccount(session: InboxSession, entities: Entities): string | null {
  const focus = session.focusEntityId ? entities[session.focusEntityId] : undefined;
  if (focus?.kind === "company") return focus.id;
  const counts = new Map<string, number>();
  for (const proposal of session.proposals) {
    if (proposal.status === "superseded") continue;
    const account = accountOf(proposal, entities);
    if (account !== null) counts.set(account, (counts.get(account) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  // A Map keeps insertion order, so the first named wins a tie.
  for (const [account, count] of counts) {
    if (count > most) {
      best = account;
      most = count;
    }
  }
  return best;
}

/** The cards of one account inside a debrief's group. */
export interface AccountGroup {
  /** Null for cards whose account nothing says. */
  readonly accountId: string | null;
  readonly proposals: readonly InboxProposal[];
}

/** One debrief's open cards, in "needs review". */
export interface CardGroup {
  readonly sessionId: string;
  readonly startedAt: string;
  /** The account the group's heading names. */
  readonly accountId: string | null;
  /** Whether the cards sit under a sub-heading per account (more than one account named). */
  readonly byAccount: boolean;
  /** One entry when `byAccount` is false; otherwise one per account, the unnamed ones last. */
  readonly accounts: readonly AccountGroup[];
}

/** A debrief that isn't sealed yet: live, or ended and finishing. */
export interface FinishingGroup {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly accountId: string | null;
  /** Its proposals still proposed, which the inbox can review once it's sealed. */
  readonly waiting: number;
}

/** A proposal outside the groups (reviewed or snoozed), with its debrief. */
export interface SessionItem {
  readonly sessionId: string;
  readonly proposal: InboxProposal;
}

export interface InboxSections {
  readonly review: readonly CardGroup[];
  readonly finishing: readonly FinishingGroup[];
  /** Newest decision first. */
  readonly reviewed: readonly SessionItem[];
  /** Soonest to wake first. */
  readonly snoozed: readonly SessionItem[];
  /** Open cards across the groups. */
  readonly openCount: number;
}

/** A debrief's open cards, arranged under its account, or under each account it names. */
function cardGroup(
  session: InboxSession,
  open: readonly InboxProposal[],
  entities: Entities,
): CardGroup {
  const byAccount = new Map<string | null, InboxProposal[]>();
  for (const proposal of open) {
    const account = accountOf(proposal, entities);
    const list = byAccount.get(account);
    if (list) list.push(proposal);
    else byAccount.set(account, [proposal]);
  }
  const named = [...byAccount.keys()].filter((account) => account !== null);
  const split = named.length > 1;
  const accounts: AccountGroup[] = split
    ? [
        ...named.map((accountId) => ({ accountId, proposals: byAccount.get(accountId) ?? [] })),
        ...(byAccount.has(null) ? [{ accountId: null, proposals: byAccount.get(null) ?? [] }] : []),
      ]
    : [{ accountId: null, proposals: open }];
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    accountId: sessionAccount(session, entities),
    byAccount: split,
    accounts,
  };
}

/** Whether a debrief's cards can be reviewed: in the inbox, once it's sealed in Postgres. */
export function isSealed(session: Pick<InboxSession, "sealedAt">): boolean {
  return session.sealedAt !== null;
}

/**
 * The inbox's sections, from the debriefs as they stand at `now` (ms since the epoch).
 * `reviewable` says which debriefs' cards can be reviewed now: the inbox's are sealed ones (the
 * rest are "Finishing"); the capture screen's tray reviews its live debrief over the socket.
 */
export function inboxSections(
  sessions: readonly InboxSession[],
  entities: Entities,
  now: number,
  reviewable: (session: InboxSession) => boolean = isSealed,
): InboxSections {
  const review: CardGroup[] = [];
  const finishing: FinishingGroup[] = [];
  const reviewed: SessionItem[] = [];
  const snoozed: SessionItem[] = [];
  for (const session of sessions) {
    if (!reviewable(session)) {
      finishing.push({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        accountId: sessionAccount(session, entities),
        waiting: session.proposals.filter((proposal) => proposal.status === "proposed").length,
      });
      continue;
    }
    const open: InboxProposal[] = [];
    for (const proposal of session.proposals) {
      if (isOpen(proposal, now)) open.push(proposal);
      else if (isSnoozed(proposal, now)) snoozed.push({ sessionId: session.sessionId, proposal });
      else if (isDecided(proposal)) reviewed.push({ sessionId: session.sessionId, proposal });
    }
    if (open.length > 0) review.push(cardGroup(session, open, entities));
  }
  const decidedAt = (item: SessionItem) => Date.parse(item.proposal.review?.ts ?? item.proposal.ts);
  reviewed.sort((a, b) => decidedAt(b) - decidedAt(a));
  const wakesAt = (item: SessionItem) => Date.parse(item.proposal.snoozedUntil ?? "");
  snoozed.sort((a, b) => wakesAt(a) - wakesAt(b));
  const openCount = review.reduce(
    (sum, group) =>
      sum + group.accounts.reduce((inner, account) => inner + account.proposals.length, 0),
    0,
  );
  return { review, finishing, reviewed, snoozed, openCount };
}

/** Each group's cards in the order they're shown: what j and k walk, and the focus rules read. */
export function cardOrder(groups: readonly CardGroup[]): string[][] {
  return groups.map((group) =>
    group.accounts.flatMap((account) => account.proposals.map((proposal) => proposal.proposalId)),
  );
}
