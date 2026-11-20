import { z } from "zod";
import { payloadMeta, Timestamp } from "./shared";

/**
 * Who sealed a session: `SessionDO` itself, after the grace that follows `end` (`session`); the
 * web Worker, repairing a session whose seal never came (`web`); or a sample session's import
 * (`import`).
 */
export const SealedBy = z.enum(["session", "web", "import"]);
export type SealedBy = z.infer<typeof SealedBy>;

/**
 * The seal (Phase 5 spec §4.3): the last event `SessionDO` writes for a session. Seqs are
 * contiguous, so once Postgres holds this event it holds the whole log, and from then on the web
 * Worker, not `SessionDO`, appends the session's reviews, snoozes, and corrections.
 */
export const SessionSealedV1 = z
  .strictObject({
    sealedAt: Timestamp,
    by: SealedBy,
  })
  .meta(
    payloadMeta(
      "session.sealed",
      1,
      "SessionSealedV1",
      "Payload of `session.sealed`, schema version 1: the session's live writer is done, and Postgres's copy of the log is whole once it holds this event.",
    ),
  );
export type SessionSealedV1 = z.infer<typeof SessionSealedV1>;
