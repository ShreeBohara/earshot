import { z } from "zod";
import { payloadMeta } from "./shared";

/** How a follow-up question closed: a correction answered it, or the rep skipped it. */
export const FollowupOutcome = z.enum(["answered", "skipped"]);
export type FollowupOutcome = z.infer<typeof FollowupOutcome>;

/**
 * A follow-up question closed (Phase 5 spec §4.1, WP13), by `SessionDO` before the seal or the web
 * Worker after it. Rules the writer keeps, which the schema can't express in JSON Schema and
 * therefore doesn't check: `proposalId` is set exactly when the outcome is `answered`, and it's the
 * superseding proposal the answer made, appended just before this event.
 */
export const FollowupClosedV1 = z
  .strictObject({
    questionId: z.uuid(),
    outcome: FollowupOutcome,
    /** The proposal the answer made, which supersedes the one asked about; null for a skip. */
    proposalId: z.uuid().nullable(),
  })
  .meta(
    payloadMeta(
      "followup.closed",
      1,
      "FollowupClosedV1",
      "Payload of `followup.closed`, schema version 1: a follow-up question answered by a correction, or skipped.",
    ),
  );
export type FollowupClosedV1 = z.infer<typeof FollowupClosedV1>;
