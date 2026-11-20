import { z } from "zod";
import { Evidence } from "./proposal-created";
import { ProviderModel } from "./session-started";
import { payloadMeta } from "./shared";

// The recap (Phase 5 spec decision 12, §4.9; ADR-0037): at the end of a debrief, one forced tool
// call on the session's own LLM writes a headline, next steps, and commitments, each sentence with
// the rep's exact words as quotes. Code locates every quote in the session's biased utterances
// and keeps a sentence only with evidence, so every stored sentence points at what was said, as
// every proposal field does. An optional methodology lens (MEDDIC, SPICED, or BANT) maps each of
// its fields to a located quote, or to "not mentioned".
//
// The payload stays structural, as every contract here does: rules across fields (a created recap
// has no reason, a failed one no sentences, at most one headline) are the writer's, and the
// session projection refuses a log that breaks them (`@earshot/events`).

/** What a recap sentence says: the call's outcome, a step the rep will take, or a promise made. */
export const RecapSentenceKind = z.enum(["headline", "next_step", "commitment"]);
export type RecapSentenceKind = z.infer<typeof RecapSentenceKind>;

/** The methodology lenses a recap can map (`packages/agent/src/recap/lenses/*.json`). */
export const RecapLensId = z.enum(["meddic", "spiced", "bant"]);
export type RecapLensId = z.infer<typeof RecapLensId>;

/** How the recap ended: written, failed at the provider or in validation, or never attempted. */
export const RecapOutcome = z.enum(["created", "failed", "skipped"]);
export type RecapOutcome = z.infer<typeof RecapOutcome>;

/**
 * Why there's no recap: no key came with `end`, the session has no speech, the model's output
 * failed validation twice, the provider rate limited the key, the provider failed or refused, or
 * the 15 s deadline passed (target).
 */
export const RecapReason = z.enum([
  "no_key",
  "no_speech",
  "invalid_output",
  "rate_limited",
  "provider_error",
  "timeout",
]);
export type RecapReason = z.infer<typeof RecapReason>;

/** The most sentences a recap keeps (spec §4.9). */
export const MAX_RECAP_SENTENCES = 12;
/** The longest sentence, in UTF-16 code units. */
export const MAX_RECAP_SENTENCE_CHARS = 400;
/** The most located quotes one sentence keeps as evidence. */
export const MAX_RECAP_EVIDENCE = 4;
/** The longest quote the model may give, for a sentence or a lens field. */
export const MAX_RECAP_QUOTE_CHARS = 200;
/** The most fields a lens holds; MEDDIC, the longest, has six. */
export const MAX_RECAP_LENS_FIELDS = 8;

/** One kept sentence: its text, the evidence for each of its located quotes, and its support. */
export const RecapSentence = z
  .strictObject({
    kind: RecapSentenceKind,
    text: z.string().min(1).max(MAX_RECAP_SENTENCE_CHARS),
    /** Where each located quote is: never empty, since a sentence with none is dropped. */
    evidence: z.array(Evidence).min(1).max(MAX_RECAP_EVIDENCE),
    /** The sentence's content words overlap its quotes under 0.5: it may say more than they do. */
    weakSupport: z.boolean(),
  })
  .meta({ title: "RecapSentence" });
export type RecapSentence = z.infer<typeof RecapSentence>;

/** A lens field id, as the lens file names it: `economic_buyer`, `critical_event`. */
export const RecapLensFieldId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/**
 * One lens field: the rep's exact words about it, with their evidence, or both null when the
 * rep didn't mention it, or the model's quote couldn't be found ("not mentioned").
 */
export const RecapLensField = z
  .strictObject({
    field: RecapLensFieldId,
    quote: z.string().min(1).max(MAX_RECAP_QUOTE_CHARS).nullable(),
    evidence: Evidence.nullable(),
  })
  .meta({ title: "RecapLensField" });
export type RecapLensField = z.infer<typeof RecapLensField>;

/** The lens the device chose, every one of its fields in the lens file's order. */
export const RecapLens = z
  .strictObject({
    id: RecapLensId,
    fields: z.array(RecapLensField).min(1).max(MAX_RECAP_LENS_FIELDS),
  })
  .meta({ title: "RecapLens" });
export type RecapLens = z.infer<typeof RecapLens>;

export const RecapCreatedV1 = z
  .strictObject({
    /** UUIDv7, minted by `SessionDO`. */
    recapId: z.uuid(),
    outcome: RecapOutcome,
    /** Why there's no recap; null when `outcome` is `created`. */
    reason: RecapReason.nullable(),
    /** The provider and model that wrote it, or would have; null when none was asked for. */
    llm: ProviderModel.nullable(),
    /** The kept sentences: at most one headline first, then next steps and commitments. */
    sentences: z.array(RecapSentence).max(MAX_RECAP_SENTENCES),
    /** Sentences the model wrote whose quotes couldn't be found in the transcript. */
    dropped: z.int().nonnegative(),
    lens: RecapLens.nullable(),
  })
  .meta(
    payloadMeta(
      "recap.created",
      1,
      "RecapCreatedV1",
      "Payload of `recap.created`, schema version 1: the debrief's recap, every kept sentence with the evidence of the rep's own words, or why there's none.",
    ),
  );
export type RecapCreatedV1 = z.infer<typeof RecapCreatedV1>;
