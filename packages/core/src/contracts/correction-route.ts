// The web Worker's correction route (Phase 5 spec §4.3, WP13): `POST /api/sessions/:id/corrections`,
// how the inbox corrects a proposal, answers a follow-up question, or skips one, once a session is
// sealed. Typed words become `utterance.final` v3 with `input: "typed"`; a one-shot dictation's
// words, with `input: "speech"`.
//
// Like the review route, these schemas aren't exported to JSON Schema or Pydantic: only TypeScript
// speaks the route, and its key-shape check has no JSON Schema form.
import { z } from "zod";
import { Confidence } from "./events/shared";
import { Word } from "./events/utterance-final";
import { CorrectionField, MAX_UTTERANCE_TEXT_CHARS, refuseStrayKeys } from "./session-protocol";

/** The longest typed correction, in UTF-16 code units (target): a name, a date, a sentence. */
export const MAX_CORRECTION_TEXT_CHARS = 500;
/** The most final segments one dictation sends (target): a correction is a few words. */
export const MAX_DICTATED_UTTERANCES = 8;
/** The most word timings one dictated segment carries (target). */
export const MAX_DICTATED_WORDS = 200;
/** The largest request body the route reads: 64 KiB of UTF-8, as the review route's (target). */
export const MAX_CORRECTION_REQUEST_BYTES = 65_536;

/**
 * Typed words: one line, trimmed by the route. Confidence 1, no word timings, at the session's last
 * audio time.
 */
const TypedWords = z.strictObject({
  input: z.literal("typed"),
  text: z.string().min(1).max(MAX_CORRECTION_TEXT_CHARS),
});

/**
 * One final segment of a one-shot dictation, as the speech-to-text provider sent it, its times and
 * its words' times from the dictation's own start. The route moves them to the session's last audio
 * time, since the dictation's audio isn't on the session's clock. The clip stays on the device.
 */
export const DictatedUtterance = z.strictObject({
  text: z.string().min(1).max(MAX_UTTERANCE_TEXT_CHARS),
  confidence: Confidence,
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  words: z.array(Word).max(MAX_DICTATED_WORDS).optional(),
});
export type DictatedUtterance = z.infer<typeof DictatedUtterance>;

/** Spoken words, from the inbox's one-shot dictation. */
const SpokenWords = z.strictObject({
  input: z.literal("speech"),
  utterances: z.array(DictatedUtterance).min(1).max(MAX_DICTATED_UTTERANCES),
});

/** A correction: of `target` or a field, with the words said or typed, maybe answering a question. */
const CorrectRequest = z.strictObject({
  t: z.literal("correct"),
  /** UUIDv7 from the client: resends are idempotent by it, and the new proposal's id derives from it. */
  correctionId: z.uuid(),
  proposalId: z.uuid(),
  field: CorrectionField,
  questionId: z.uuid().optional(),
  said: z.discriminatedUnion("input", [TypedWords, SpokenWords]),
});

/** A follow-up question skipped. */
const SkipRequest = z.strictObject({
  t: z.literal("skip"),
  questionId: z.uuid(),
});

/**
 * What the route takes: one correction, or one skip. Anything shaped like a key, anywhere, is
 * refused.
 */
export const CorrectionRouteRequest = z
  .discriminatedUnion("t", [CorrectRequest, SkipRequest])
  .superRefine(refuseStrayKeys);
export type CorrectionRouteRequest = z.infer<typeof CorrectionRouteRequest>;

/** `POST /api/sessions/:id/corrections`, 200: the correction or the skip is in the session's log. */
export interface CorrectionRouteResponse {
  readonly sessionId: string;
  /** `corrected`: a proposal now supersedes the one corrected. `skipped`: the question is closed. */
  readonly outcome: "corrected" | "skipped";
  /** The superseding proposal's id, for a correction; null for a skip. */
  readonly proposalId: string | null;
  /** `now` if this request wrote it, `before` if the log already held it (a resend). */
  readonly recorded: "now" | "before";
  /** The log's last seq after the request. */
  readonly lastSeq: number;
}

/**
 * Why the route refused a request: a fixed code, and nothing quoted from the request.
 *
 * - `not_sealed` (409): the session isn't sealed in Postgres yet; correct it in the capture screen,
 *   or wait for it to finish.
 * - `stale` (409): the proposal was decided, replaced, or the question closed since the card loaded.
 * - `unreadable` (422): the words hold no value of the field's kind ("I couldn't read a date in …");
 *   nothing was written.
 */
export type CorrectionRouteError =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "too_large"
  | "not_found"
  | "not_sealed"
  | "stale"
  | "unreadable"
  | "server_error";

/** The body of every refusal. */
export interface CorrectionRouteErrorBody {
  readonly error: CorrectionRouteError;
  readonly message: string;
}
