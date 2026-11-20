// What a card sends (Phase 5 spec §4.1, WP5 steps 4 and 9): each review as `ReviewInput`, the
// v2 payload a person sends, with what the reviewer saw (`seen`), the review clock's `timing`, the
// input that made it, and the surface. The route fills `by` and `syncEligibleAt`.
import {
  type FieldEdit,
  type FieldValue,
  type ReviewInput,
  type ReviewInputKind,
  type ReviewSeen,
  type ReviewSurface,
  type ReviewTiming,
  type SeenField,
  type SnoozeInput,
  uuidv7,
} from "@earshot/core";
import { tierOf } from "@earshot/understanding/tiers";
import { askCandidates } from "@/lib/capture/copy";
import type { InboxEntity, InboxProposal } from "./types";

type Entities = Readonly<Record<string, InboxEntity>>;

/** The fields an update reads against the CRM's current value, by proposal type. */
const UPDATE_FIELDS: Readonly<Partial<Record<InboxProposal["type"], readonly string[]>>> = {
  deal_update: ["stage", "amount", "closeDate"],
  contact: ["title", "email", "phone"],
};

/**
 * The CRM's value a field updates, as the card shows it "before": only for an update (a deal's
 * stage, amount, or close date; a linked contact's title, email, or phone) whose record the
 * mirror holds. Undefined otherwise: notes, tasks, commitments, and meetings create records.
 */
export function beforeValue(
  proposal: InboxProposal,
  field: string,
  entities: Entities,
): FieldValue | undefined {
  const { target } = proposal;
  if (target.decision !== "linked" || target.entityId === null) return undefined;
  if (!UPDATE_FIELDS[proposal.type]?.includes(field)) return undefined;
  const values = entities[target.entityId]?.values;
  return values && field in values ? values[field] : undefined;
}

/**
 * What the reviewer saw (`seen`): the card's tier, each field's proposed value (with the CRM's
 * value as "before" for an update: `base`, since there's no history yet to tell it from `current`;
 * WP12 adds that), the record shown and the records offered, and no clip (WP9 adds clips).
 */
export function seenOf(
  proposal: InboxProposal,
  entities: Entities,
  offered?: readonly (string | null)[],
): ReviewSeen {
  const fields: Record<string, SeenField> = {};
  for (const [name, field] of Object.entries(proposal.fields)) {
    const base = beforeValue(proposal, name, entities);
    fields[name] = base === undefined ? { proposed: field.value } : { proposed: field.value, base };
  }
  const { target } = proposal;
  const shown =
    target.decision === "ask"
      ? askCandidates(target).map((candidate) => candidate.entityId)
      : (offered ?? []);
  const seenTarget: ReviewSeen["target"] =
    target.decision === "linked"
      ? { entityId: target.entityId, offered: [...shown] }
      : target.decision === "none" && shown.length === 0
        ? null
        : { entityId: null, offered: [...shown] };
  return {
    tier: tierOf(proposal).tier,
    fields,
    target: seenTarget,
    relinked: null,
    clip: "none",
  };
}

export interface DecisionArgs {
  readonly proposal: InboxProposal;
  readonly entities: Entities;
  readonly decision: "approved" | "edited" | "rejected";
  /** The record chosen: a question's answer, or another record from the correction panel. */
  readonly target?: { readonly entityId: string | null } | null;
  /** For an edit: the fields changed, at least one. */
  readonly editDiff?: Readonly<Record<string, FieldEdit>>;
  readonly timing: ReviewTiming;
  readonly input: ReviewInputKind;
  /** The records the card offered (a question's candidates, the correction panel's). */
  readonly offered?: readonly (string | null)[];
  readonly surface?: ReviewSurface;
  /** Fixed in tests; a fresh UUIDv7 otherwise. */
  readonly reviewId?: string;
}

/** A decision on one card, as the card sends it. */
export function decisionReview(args: DecisionArgs): ReviewInput {
  const { proposal, decision } = args;
  return {
    reviewId: args.reviewId ?? uuidv7(),
    proposalId: proposal.proposalId,
    decision,
    target: decision === "rejected" ? null : (args.target ?? null),
    ...(decision === "edited" && args.editDiff ? { editDiff: { ...args.editDiff } } : {}),
    mode: "single",
    batchId: null,
    policy: null,
    undoes: null,
    reason: null,
    seen: seenOf(proposal, args.entities, args.offered),
    timing: args.timing,
    input: args.input,
    surface: args.surface ?? "inbox",
  };
}

/**
 * An undo: a reopen naming the proposal's latest review, which returns it to proposed. It takes no
 * time of its own on the review clock (the card isn't on screen to time), so its timing is zero.
 */
export function undoReview(args: {
  readonly proposal: InboxProposal;
  readonly entities: Entities;
  readonly undoes: string;
  readonly input: ReviewInputKind;
  readonly surface?: ReviewSurface;
  readonly reviewId?: string;
}): ReviewInput {
  return {
    reviewId: args.reviewId ?? uuidv7(),
    proposalId: args.proposal.proposalId,
    decision: "reopened",
    target: null,
    mode: "single",
    batchId: null,
    policy: null,
    undoes: args.undoes,
    reason: "undo",
    seen: seenOf(args.proposal, args.entities),
    timing: { decisionMs: 0, handlingMs: 0 },
    input: args.input,
    surface: args.surface ?? "inbox",
  };
}

/** A snooze until `until`, or a wake (`until: null`). */
export function snoozeOf(
  proposalId: string,
  until: Date | null,
  snoozeId: string = uuidv7(),
): SnoozeInput {
  return { snoozeId, proposalId, until: until === null ? null : until.toISOString() };
}

/** What a review makes of the card, as the inbox holds its latest review. */
export function reviewedState(
  review: ReviewInput,
  now: Date,
  undoWindowMs: number,
): { status: InboxProposal["status"]; review: NonNullable<InboxProposal["review"]> } {
  const decides = review.decision === "approved" || review.decision === "edited";
  return {
    status: review.decision === "reopened" ? "proposed" : review.decision,
    review: {
      reviewId: review.reviewId,
      decision: review.decision,
      target: review.target,
      mode: review.mode,
      batchId: review.batchId,
      undoes: review.undoes,
      syncEligibleAt: decides ? new Date(now.getTime() + undoWindowMs).toISOString() : null,
      ts: now.toISOString(),
    },
  };
}
