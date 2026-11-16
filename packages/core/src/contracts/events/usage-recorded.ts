import { z } from "zod";
import { payloadMeta } from "./shared";

/** What a usage record measures: speech-to-text audio, an LLM call, or a speech-to-speech session. */
export const UsageKind = z.enum(["stt", "llm", "speech_to_speech"]);
export type UsageKind = z.infer<typeof UsageKind>;

const Count = z.int().nonnegative();

export const UsageRecordedV1 = z
  .strictObject({
    /** UUIDv7, minted by `SessionDO`. */
    usageId: z.uuid(),
    kind: UsageKind,
    /** The provider and model billed, for example `assemblyai` and `universal-streaming-english`. */
    provider: z.string().min(1),
    model: z.string().min(1),
    /** Audio sent to the provider, in ms. */
    audioMs: Count.optional(),
    /** How long the provider's socket was open, in ms. AssemblyAI bills this, idle time included. */
    socketMs: Count.optional(),
    /** Every input token, cached ones included. */
    inputTokens: Count.optional(),
    /** Every output token. Reasoning tokens bill as output, so they're included. */
    outputTokens: Count.optional(),
    /** How many of `inputTokens` the provider served from its prompt cache. */
    cachedInputTokens: Count.optional(),
    /** What this usage cost in provider fees, in US dollars, priced when it was recorded. */
    costUsd: z.number().nonnegative(),
    /** The date of the price table `costUsd` came from (`YYYY-MM-DD`), so old costs stay explicable. */
    priceTable: z.iso.date(),
  })
  .meta(
    payloadMeta(
      "usage.recorded",
      1,
      "UsageRecordedV1",
      "Payload of `usage.recorded`, schema version 1: one priced use of a provider, for the cost meter.",
    ),
  );
export type UsageRecordedV1 = z.infer<typeof UsageRecordedV1>;
