import { z } from "zod";
import { FieldName, FieldValue, payloadMeta } from "./shared";

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
