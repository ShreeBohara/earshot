import { z } from "zod";
import { payloadMeta, Timestamp } from "./shared";

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
