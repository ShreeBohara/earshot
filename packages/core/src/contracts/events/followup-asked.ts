import { z } from "zod";
import { FieldName, payloadMeta } from "./shared";

/**
 * Which rule asked a follow-up question (Phase 5 spec WP13 step 3, Phase 4's WP14 base rules), each
 * for a value a proposal needs and doesn't have:
 * - `due_date`: a task or a commitment with no due date;
 * - `meeting_date`: a meeting with no date;
 * - `deal_amount`: a deal update that moves the stage but names no amount.
 */
export const FollowupRule = z.enum(["due_date", "meeting_date", "deal_amount"]);
export type FollowupRule = z.infer<typeof FollowupRule>;

/** The longest question a follow-up asks, in UTF-16 code units (target). */
export const MAX_FOLLOWUP_TEXT_CHARS = 200;

/**
 * A follow-up question (Phase 5 spec §4.1, WP13): after a turn's proposals, `SessionDO` asks for a
 * value a proposal needs, at most two a turn and none on a loud card. The inbox shows it as a card
 * after its proposal; an answer is a correction of `field` that names the question, and a skip
 * closes it (`followup.closed`).
 */
export const FollowupAskedV1 = z
  .strictObject({
    /** UUIDv7, minted by `SessionDO`. `followup.closed` and the `correct` message name it. */
    questionId: z.uuid(),
    /** The turn whose proposals raised it. */
    turnId: z.uuid(),
    /** The proposal it asks about. */
    proposalId: z.uuid(),
    /** The field it asks for, such as `dueDate`. */
    field: FieldName,
    rule: FollowupRule,
    /** The question as the card shows it: "When is it due?" */
    text: z.string().min(1).max(MAX_FOLLOWUP_TEXT_CHARS),
  })
  .meta(
    payloadMeta(
      "followup.asked",
      1,
      "FollowupAskedV1",
      "Payload of `followup.asked`, schema version 1: a question about a value a proposal needs and doesn't have.",
    ),
  );
export type FollowupAskedV1 = z.infer<typeof FollowupAskedV1>;
