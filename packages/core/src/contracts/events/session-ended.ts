import { z } from "zod";
import { payloadMeta, Timestamp } from "./shared";

export const SessionEndedV1 = z
  .strictObject({
    /** When capture stopped, by the client's clock. */
    endedAt: Timestamp,
    /** What the session cost in provider fees, in US dollars, from the cost meter. */
    costUsd: z.number().nonnegative().optional(),
  })
  .meta(
    payloadMeta(
      "session.ended",
      1,
      "SessionEndedV1",
      "Payload of `session.ended`, schema version 1: when capture stopped and what it cost.",
    ),
  );
export type SessionEndedV1 = z.infer<typeof SessionEndedV1>;
