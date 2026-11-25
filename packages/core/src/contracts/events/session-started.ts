import { z } from "zod";
import { payloadMeta, Timestamp, TimeZoneName } from "./shared";

/** What the rep is doing: a dictated debrief, a back-and-forth conversation, or a local session. */
export const SessionMode = z.enum(["debrief", "conversation", "local"]);
export type SessionMode = z.infer<typeof SessionMode>;

/**
 * The voice pipeline behind the session (ADR-0001): speech-to-text then an LLM, a speech-to-speech
 * model, or models running on the device.
 */
export const VoiceEngine = z.enum(["cascaded", "speech_to_speech", "on_device"]);
export type VoiceEngine = z.infer<typeof VoiceEngine>;

/** A provider and one of its models, for example `deepgram` and `nova-3`. */
export const ProviderModel = z
  .strictObject({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .meta({ id: "ProviderModel", title: "ProviderModel" });
export type ProviderModel = z.infer<typeof ProviderModel>;

/** The providers a session uses, by role. Which roles are set depends on the engine. */
export const SessionProviders = z
  .strictObject({
    speechToText: ProviderModel.optional(),
    llm: ProviderModel.optional(),
    speechToSpeech: ProviderModel.optional(),
    textToSpeech: ProviderModel.optional(),
  })
  .meta({ title: "SessionProviders" });
export type SessionProviders = z.infer<typeof SessionProviders>;

export const SessionStartedV1 = z
  .strictObject({
    mode: SessionMode,
    engine: VoiceEngine,
    providers: SessionProviders,
    /** When capture started, by the client's clock. */
    startedAt: Timestamp,
  })
  .meta(
    payloadMeta(
      "session.started",
      1,
      "SessionStartedV1",
      "Payload of `session.started`, schema version 1: how a session was set up.",
    ),
  );
export type SessionStartedV1 = z.infer<typeof SessionStartedV1>;

// ─── Version 2 (Phase 6 spec §4.1, §4.3) ───────────────────────────────────────────────────────
// `start` has carried the rep's IANA time zone since Phase 3, but SessionDO kept it only in its own
// store, so nothing after the seal could read it. Phase 6's sync reads a task's due time and a
// meeting's start in it, so version 2 records it. v1's exports above stay frozen: stored v1 events
// upcast to v2 with a null zone (`@earshot/events`).

export const SessionStartedV2 = SessionStartedV1.extend({
  /**
   * The rep's IANA time zone, as `start` sent it (`America/Chicago`), or null when it sent none,
   * which readers take as UTC. `start` was checked against `Intl` when it arrived; here only its
   * shape and length are, so the event loads in any runtime (`TimeZoneName`).
   */
  timeZone: TimeZoneName.nullable(),
}).meta(
  payloadMeta(
    "session.started",
    2,
    "SessionStartedV2",
    "Payload of `session.started`, schema version 2: how a session was set up, and the rep's time zone.",
  ),
);
export type SessionStartedV2 = z.infer<typeof SessionStartedV2>;
