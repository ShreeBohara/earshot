import { z } from "zod";
import { Reviewer } from "./proposal-reviewed";
import { payloadMeta, Timestamp } from "./shared";

/**
 * A snooze hides a proposal from the inbox until a time; a snooze with no time wakes it. It
 * decides nothing, so it isn't a review: it has no timing, no audit entry, and no effect on sync.
 */
export const ProposalSnoozedV1 = z
  .strictObject({
    /** UUIDv7 from the client, so a snooze is idempotent across the socket and the web route. */
    snoozeId: z.uuid(),
    proposalId: z.uuid(),
    /** When the proposal comes back; null wakes it now. */
    until: Timestamp.nullable(),
    by: Reviewer,
  })
  .meta(
    payloadMeta(
      "proposal.snoozed",
      1,
      "ProposalSnoozedV1",
      "Payload of `proposal.snoozed`, schema version 1: a proposal set aside until a time, or woken.",
    ),
  );
export type ProposalSnoozedV1 = z.infer<typeof ProposalSnoozedV1>;
