import { z } from "zod";
import { MAX_TARGET_CANDIDATES } from "./proposal-created";
import { FieldName, FieldValue, payloadMeta, Timestamp } from "./shared";

/** What the reviewer did with a proposal (ADR-0007: CRM writes happen only after approval). */
export const ReviewDecision = z.enum(["approved", "edited", "rejected"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** One field the reviewer changed. `before` is `null` for a field the reviewer added. */
export const FieldEdit = z
  .strictObject({
    before: FieldValue,
    after: FieldValue,
  })
  .meta({ title: "FieldEdit" });
export type FieldEdit = z.infer<typeof FieldEdit>;

export const ProposalReviewedV1 = z
  .strictObject({
    proposalId: z.uuid(),
    decision: ReviewDecision,
    /** The reviewer's changes, by field name. Set when `decision` is `edited`. */
    editDiff: z.record(FieldName, FieldEdit).optional(),
    /** How long the reviewer spent on the proposal, in ms. */
    reviewerMs: z.int().nonnegative(),
  })
  .meta(
    payloadMeta(
      "proposal.reviewed",
      1,
      "ProposalReviewedV1",
      "Payload of `proposal.reviewed`, schema version 1: the reviewer's decision on one proposal.",
    ),
  );
export type ProposalReviewedV1 = z.infer<typeof ProposalReviewedV1>;

// ─── Version 2 (Phase 5 spec §4.1) ─────────────────────────────────────────────────────────────
// A review records the record chosen, how it was made (alone, in a batch, by a policy, or by
// SessionDO itself), what the reviewer saw, and when an approval may sync. Undo is a later
// review (`reopened`), never a deletion, and a snooze is its own event (`proposal.snoozed`).
// v1's exports above stay frozen: stored v1 reviews upcast to v2 on read (`@earshot/events`).

/**
 * The undo window (Phase 5 spec decision 3, target): an approval or an edit may sync to the CRM
 * this long after it's made, not before. Each writer sets `syncEligibleAt` to its own clock plus
 * this: `SessionDO` for the tray's reviews, the web Worker for the inbox's.
 */
export const UNDO_WINDOW_MS = 30_000;

/** v1's three decisions, plus `reopened`: an undo, or a later conflict, returns it to proposed. */
export const ReviewDecisionV2 = z.enum(["approved", "edited", "rejected", "reopened"]);
export type ReviewDecisionV2 = z.infer<typeof ReviewDecisionV2>;

/**
 * How a review was made: one card at a time, "accept all" (`batch`), an approval policy's
 * auto-approval (`policy`), or SessionDO reopening an approval that a later flag put in doubt
 * (`system`). Only `single` and `batch` are a person's, so only they count toward review timings.
 */
export const ReviewMode = z.enum(["single", "batch", "policy", "system"]);
export type ReviewMode = z.infer<typeof ReviewMode>;

/** What the reviewer decided with. `none` for a policy's or SessionDO's own reviews. */
export const ReviewInputKind = z.enum(["keyboard", "pointer", "touch", "voice", "none"]);
export type ReviewInputKind = z.infer<typeof ReviewInputKind>;

/**
 * Where the review was made: the inbox, the capture screen's tray, the pilot page, or SessionDO
 * itself (`session`, for policy and system reviews).
 */
export const ReviewSurface = z.enum(["inbox", "tray", "pilot", "session"]);
export type ReviewSurface = z.infer<typeof ReviewSurface>;

/** How the reviewer's web session signed in. `unknown` when that wasn't recorded. */
export const SignInMethod = z.enum(["passkey", "magic_link", "github", "google", "unknown"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/**
 * How loudly a card asked for a check (Phase 5 spec §4.4): amber with a first-person question,
 * a short quiet note, or nothing.
 */
export const LikelyEditTier = z.enum(["loud", "quiet", "none"]);
export type LikelyEditTier = z.infer<typeof LikelyEditTier>;

/** Why a proposal was reopened: the reviewer's undo, or a later flag on an approval. */
export const ReopenReason = z.enum(["undo", "flagged"]);
export type ReopenReason = z.infer<typeof ReopenReason>;

/** Who made a review or a snooze, and how and when their web session signed in. */
export const Reviewer = z
  .strictObject({
    userId: z.string().min(1).max(128),
    /** Null for policy and system reviews, which nobody signed in to make. */
    auth: z
      .strictObject({ method: SignInMethod, signedInAt: Timestamp })
      .meta({ title: "ReviewerAuth" })
      .nullable(),
  })
  .meta({ title: "Reviewer" });
export type Reviewer = z.infer<typeof Reviewer>;

/** One field as the card showed it. */
export const SeenField = z
  .strictObject({
    /** The value the card showed. */
    proposed: FieldValue,
    /** The CRM's value when the proposal was made (updates only). */
    base: FieldValue.optional(),
    /** The CRM's value when the card was shown; set only when it differed from `base`. */
    current: FieldValue.optional(),
  })
  .meta({ title: "SeenField" });
export type SeenField = z.infer<typeof SeenField>;

/** The record the reviewer chose. A `null` id is a new record. */
export const ReviewTarget = z
  .strictObject({ entityId: z.string().min(1).nullable() })
  .meta({ title: "ReviewTarget" });
export type ReviewTarget = z.infer<typeof ReviewTarget>;

/** The approval policy behind an auto-approval: its id, its version, and the rule that matched. */
export const ReviewPolicy = z
  .strictObject({ id: z.uuid(), version: z.int().positive(), rule: z.string().min(1) })
  .meta({ title: "ReviewPolicy" });
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

/** The record the card showed, and the records it offered, by id (a `null` id is "new"). */
export const SeenTarget = z
  .strictObject({
    entityId: z.string().min(1).nullable(),
    offered: z.array(z.string().min(1).nullable()).max(MAX_TARGET_CANDIDATES),
  })
  .meta({ title: "SeenTarget" });
export type SeenTarget = z.infer<typeof SeenTarget>;

/** What the reviewer saw: the card's tier, its fields and record, and its evidence clip. */
export const ReviewSeen = z
  .strictObject({
    tier: LikelyEditTier,
    fields: z.record(FieldName, SeenField),
    target: SeenTarget.nullable(),
    /** A record offered at review time, because it reached the CRM after the proposal. */
    relinked: z.string().min(1).nullable(),
    clip: z.enum(["played", "available", "none"]),
  })
  .meta({ title: "ReviewSeen" });
export type ReviewSeen = z.infer<typeof ReviewSeen>;

/**
 * The review clock (Phase 5 spec §4.8): active time to the first decision key or click, and to
 * the moment the decision committed. Zero for policy and system reviews; each of a batch's items
 * carries the batch's own time.
 */
export const ReviewTiming = z
  .strictObject({ decisionMs: z.int().nonnegative(), handlingMs: z.int().nonnegative() })
  .meta({ title: "ReviewTiming" });
export type ReviewTiming = z.infer<typeof ReviewTiming>;

/**
 * Rules the writers keep, which the schema can't express in JSON Schema and therefore doesn't
 * check (`checkReview` in `@earshot/events` holds them; ADR-0032):
 * - `batchId` is set exactly when `mode` is `batch`, and `policy` exactly when it's `policy`;
 * - `undoes` and `reason` are set exactly when `decision` is `reopened`;
 * - `editDiff` is set exactly when `decision` is `edited`;
 * - `syncEligibleAt` is set exactly when `decision` is `approved` or `edited`;
 * - `seen`, `input`, `surface`, and `by` are null only on a review upcast from v1, whose
 *   `syncEligibleAt` is null too, so nothing upcast from v1 is eligible to sync.
 */
export const ProposalReviewedV2 = z
  .strictObject({
    /** UUIDv7 from the client, so a review is idempotent across the socket and the web route. */
    reviewId: z.uuid(),
    proposalId: z.uuid(),
    decision: ReviewDecisionV2,
    /** The record the reviewer chose, when they chose one; null otherwise. */
    target: ReviewTarget.nullable(),
    /** The reviewer's changes, by field name. Set when `decision` is `edited`. */
    editDiff: z.record(FieldName, FieldEdit).optional(),
    mode: ReviewMode,
    /** One id for every review one "accept all" wrote. Set exactly when `mode` is `batch`. */
    batchId: z.uuid().nullable(),
    /** The policy behind an auto-approval. Set exactly when `mode` is `policy`. */
    policy: ReviewPolicy.nullable(),
    /** The `reviewId` this review reverses. Set exactly when `decision` is `reopened`. */
    undoes: z.uuid().nullable(),
    /** Why a reopen happened. Set exactly when `decision` is `reopened`. */
    reason: ReopenReason.nullable(),
    /** What the reviewer saw. Null only when upcast from v1. */
    seen: ReviewSeen.nullable(),
    timing: ReviewTiming,
    input: ReviewInputKind.nullable(),
    surface: ReviewSurface.nullable(),
    /** When an approval may sync to the CRM: the review's time plus the undo window. */
    syncEligibleAt: Timestamp.nullable(),
    /** Who reviewed. Null only when upcast from v1. */
    by: Reviewer.nullable(),
  })
  .meta(
    payloadMeta(
      "proposal.reviewed",
      2,
      "ProposalReviewedV2",
      "Payload of `proposal.reviewed`, schema version 2: a decision on one proposal, the record chosen, how and by whom it was made, what the reviewer saw, and when an approval may sync. An undo is a later review that reopens the proposal.",
    ),
  );
export type ProposalReviewedV2 = z.infer<typeof ProposalReviewedV2>;
