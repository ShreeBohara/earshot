// The inbox's data (Phase 5 spec WP5 step 1): what the loader reads under `withTenant` and the
// client view renders. Plain JSON, since it crosses from the server component to the page, and
// from `GET /api/inbox` when the page polls a finishing debrief or loads older ones.
import type { EntityKind, FieldValue } from "@earshot/core";
import type { ProposalView, ReviewView } from "@earshot/events";

/**
 * The parts of a proposal's latest review the inbox reads: which review an undo names, what it
 * decided, the record it chose, and when its undo window closes (`syncEligibleAt`).
 */
export type InboxReview = Pick<
  ReviewView,
  "reviewId" | "decision" | "target" | "mode" | "batchId" | "undoes" | "syncEligibleAt" | "ts"
>;

/** A proposal as the inbox holds it: the projection's view, with a trimmed latest review. */
export type InboxProposal = Omit<ProposalView, "review"> & { review: InboxReview | null };

/** A CRM record a card names: a target, a candidate, a company said with a target, a focus account. */
export interface InboxEntity {
  readonly id: string;
  readonly kind: EntityKind;
  readonly name: string;
  /**
   * The account the record belongs to: a company's own id, a contact's or deal's company, or null
   * when the mirror doesn't say.
   */
  readonly accountId: string | null;
  /**
   * The CRM's current values that an update's fields read as "before": a deal's stage, amount, and
   * close date; a contact's title, email, and phone. Only the ones the mirror holds.
   */
  readonly values: Readonly<Record<string, FieldValue>>;
}

/** One of the viewer's debriefs, with every proposal it made, in the order it made them. */
export interface InboxSession {
  readonly sessionId: string;
  readonly startedAt: string;
  /** Null while the debrief is live. */
  readonly endedAt: string | null;
  /** Null until `session.sealed` reaches Postgres: until then the inbox can't review it. */
  readonly sealedAt: string | null;
  /** The account open when the debrief started, if any. */
  readonly focusEntityId: string | null;
  readonly proposals: readonly InboxProposal[];
}

export interface InboxData {
  /** Newest first. */
  readonly sessions: readonly InboxSession[];
  /** The records the cards name, by id. */
  readonly entities: Readonly<Record<string, InboxEntity>>;
  /** The texts of the utterances the cards quote, by utterance id. */
  readonly quotes: Readonly<Record<string, string>>;
  /** Where "Load older" continues from, or null when there's nothing older. */
  readonly older: string | null;
  /** The server's clock when it read this. */
  readonly loadedAt: string;
}
