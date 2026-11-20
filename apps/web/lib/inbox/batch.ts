// "Accept all from this call" (Phase 5 spec decisions 3 and 7, §4.4, §4.8, WP6 step 1; ADR-0035):
// which of a debrief's open cards one batch takes, the reviews the batch writes, and the reopens
// that undo it. Pure, so the tests hold the set against the writers' own rule (`checkReview`, with
// the `tierOf` the route and SessionDO pass), and the page never builds a batch they'd refuse.
//
// - **What it takes:** the debrief's open cards (proposed, not snoozed) with nothing of the page's
//   still on its way, that `tierOf` leaves unmarked (`none`), and that can be accepted as they
//   stand: with a record to add them to. A card with no record can't be approved at all
//   (`checkReview`'s `no_target`), and a question is always loud. Everything else stays for review,
//   each with why: loud, a quiet note, a name note, no record, or still being saved.
// - **What it writes:** one `proposal.reviewed` v2 per card, approved as proposed, in `batch` mode
//   with one `batchId` (a UUIDv7). Every item carries the batch's own time, from opening the
//   checkpoint to confirming it (§4.8), and the analysis counts each `batchId` once. The input is
//   the confirming event's; the surface is where it happened.
// - **Undo:** one reopen per card whose latest review is still the batch's, each naming its own
//   item's review (`checkReview`'s rule for reopens), in `batch` mode with the batch's own id
//   ("a batch approves or undoes"), and zero time, as every undo has.
import {
  type ReviewInput,
  type ReviewInputKind,
  type ReviewSurface,
  type ReviewTiming,
  uuidv7,
} from "@earshot/core";
import { tierOf } from "@earshot/understanding/tiers";
import type { SessionItem } from "./groups";
import { seenOf } from "./review";
import type { InboxEntity, InboxProposal } from "./types";

type Entities = Readonly<Record<string, InboxEntity>>;

/**
 * Why a card stays out of "accept all":
 * - `loud`: it needs a check (a question, a conflict, words not found, ...);
 * - `quiet`: it carries a note (an assumed account, a corrected value, ...);
 * - `name_note`: its record was matched by sound or in context, not by its exact name;
 * - `no_record`: there's no record to add it to, so it can't be accepted as it stands;
 * - `saving`: a review of it is still on its way.
 */
export type StayReason = "loud" | "quiet" | "name_note" | "no_record" | "saving";

/** A card that stays for review, and why. */
export interface BatchStay {
  readonly proposal: InboxProposal;
  readonly reason: StayReason;
}

/** What "accept all" would do to one debrief's open cards, in the order the group shows them. */
export interface BatchPlan {
  readonly sessionId: string;
  readonly accept: readonly InboxProposal[];
  readonly stay: readonly BatchStay[];
}

/**
 * Why a card can't join a batch, from its marks and its record alone, or null when it can. The
 * marks come first, since they're what the card shows; a card that only waits on the page's own
 * request is `saving`.
 */
export function stayReason(proposal: InboxProposal, pending: boolean): StayReason | null {
  const tier = tierOf(proposal);
  if (tier.tier === "loud" || proposal.target.decision === "ask") return "loud";
  if (proposal.target.decision === "none") return "no_record";
  if (tier.tier === "quiet") {
    return tier.reasons.some((reason) => reason.tier === "quiet") ? "quiet" : "name_note";
  }
  return pending ? "saving" : null;
}

/**
 * "Accept all" for one debrief: of its open cards (`open`, as its group shows them), the ones a
 * batch takes, and the rest with why they stay. `pending` says whether the page still has a change
 * to a card on its way.
 */
export function batchPlan(
  sessionId: string,
  open: readonly InboxProposal[],
  pending: (proposalId: string) => boolean = () => false,
): BatchPlan {
  const accept: InboxProposal[] = [];
  const stay: BatchStay[] = [];
  for (const proposal of open) {
    const reason = stayReason(proposal, pending(proposal.proposalId));
    if (reason === null) accept.push(proposal);
    else stay.push({ proposal, reason });
  }
  return { sessionId, accept, stay };
}

export interface BatchArgs {
  readonly entities: Entities;
  /** The batch's own time: from opening the checkpoint to confirming it. */
  readonly timing: ReviewTiming;
  /** The confirming event's input. */
  readonly input: ReviewInputKind;
  readonly surface: ReviewSurface;
  /** Fixed in tests; a fresh UUIDv7 otherwise. */
  readonly batchId?: string;
  /** Fixed in tests; fresh UUIDv7s otherwise, one per card. */
  readonly reviewIds?: readonly string[];
}

/** The batch's reviews: one approval per card, as proposed, all with one `batchId`. */
export function batchReviews(
  accept: readonly InboxProposal[],
  args: BatchArgs,
): { readonly batchId: string; readonly reviews: ReviewInput[] } {
  const batchId = args.batchId ?? uuidv7();
  const reviews = accept.map(
    (proposal, index): ReviewInput => ({
      reviewId: args.reviewIds?.[index] ?? uuidv7(),
      proposalId: proposal.proposalId,
      decision: "approved",
      target: null,
      mode: "batch",
      batchId,
      policy: null,
      undoes: null,
      reason: null,
      seen: seenOf(proposal, args.entities),
      timing: args.timing,
      input: args.input,
      surface: args.surface,
    }),
  );
  return { batchId, reviews };
}

/**
 * The cards a batch still stands on: those whose latest review is the batch's approval. A card
 * reopened or decided again since is the reviewer's own business, and an undo leaves it alone.
 */
export function batchItems<T extends InboxProposal>(proposals: Iterable<T>, batchId: string): T[] {
  const items: T[] = [];
  for (const proposal of proposals) {
    const { review } = proposal;
    if (
      proposal.status === "approved" &&
      review?.mode === "batch" &&
      review.batchId === batchId &&
      review.decision === "approved"
    ) {
      items.push(proposal);
    }
  }
  return items;
}

/**
 * The batch's undo: one reopen per card it still stands on, each naming that card's own review,
 * in batch mode with the batch's id, and no time of its own (the cards aren't on screen to time).
 */
export function batchUndoReviews(
  items: readonly InboxProposal[],
  args: {
    readonly batchId: string;
    readonly entities: Entities;
    readonly input: ReviewInputKind;
    readonly surface: ReviewSurface;
    readonly reviewIds?: readonly string[];
  },
): ReviewInput[] {
  return items.flatMap((proposal, index): ReviewInput[] => {
    const undoes = proposal.review?.reviewId;
    if (!undoes) return [];
    return [
      {
        reviewId: args.reviewIds?.[index] ?? uuidv7(),
        proposalId: proposal.proposalId,
        decision: "reopened",
        target: null,
        mode: "batch",
        batchId: args.batchId,
        policy: null,
        undoes,
        reason: "undo",
        seen: seenOf(proposal, args.entities),
        timing: { decisionMs: 0, handlingMs: 0 },
        input: args.input,
        surface: args.surface,
      },
    ];
  });
}

/** A row in "Reviewed": one decision, or the cards a batch still stands on, together. */
export type ReviewedRow =
  | { readonly kind: "single"; readonly item: SessionItem }
  | {
      readonly kind: "batch";
      readonly batchId: string;
      readonly sessionId: string;
      readonly items: readonly SessionItem[];
    };

/**
 * "Reviewed"'s rows: each decision its own, except a batch's, which share one row where its first
 * card would be, with one Undo for them all. A card reopened or decided again since leaves its
 * batch's row, as `batchItems` leaves it out of the batch's undo.
 */
export function reviewedRows(items: readonly SessionItem[]): ReviewedRow[] {
  const rows: ReviewedRow[] = [];
  const batches = new Map<string, SessionItem[]>();
  for (const item of items) {
    const batchId = item.proposal.review?.batchId;
    if (batchId && batchItems([item.proposal], batchId).length > 0) {
      const cards = batches.get(batchId);
      if (cards) {
        cards.push(item);
        continue;
      }
      const first = [item];
      batches.set(batchId, first);
      rows.push({ kind: "batch", batchId, sessionId: item.sessionId, items: first });
      continue;
    }
    rows.push({ kind: "single", item });
  }
  return rows;
}
