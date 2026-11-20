// The voice engine interface (spec §4.1). The Debrief engine (cascaded: speech-to-text here, the
// LLM in SessionDO) implements it now; the Conversation engine (speech-to-speech, WP12) later.
import type { UtteranceFinalV2 } from "@earshot/core";
import type { EngineState, TurnTrigger, VoiceErrorCode } from "./codes";
import type { TurnAudio } from "./witness/turn-audio";

export type VoiceEvent =
  /** A live transcript for the UI only; never sent to SessionDO. Times in session audio ms. */
  | { type: "partial"; text: string; startMs: number; endMs: number }
  /** A final transcript segment, in session audio ms. SessionClient sends it as `utterance`. */
  | { type: "final"; turnId: string; utterance: UtteranceFinalV2 }
  /** The turn's speech is over and its finals have all been emitted. */
  | { type: "turn_end"; turnId: string; trigger: TurnTrigger }
  /**
   * The turn's audio, for the second witness: only from an engine that records it
   * (`turnAudio`), once per `turn_end` and right after it, or as soon as the audio's tail is in.
   * Null for a turn with no audio of its own (a late final delivered as a turn). Never sent to
   * SessionDO: the browser sends it to the witness's provider itself.
   */
  | { type: "turn_audio"; turnId: string; audio: TurnAudio | null }
  /** Levels for the orb, 0 to 1, about 31 times a second. */
  | { type: "level"; mic: number; agent: number }
  /** Conversation engine only. */
  | { type: "agent_text"; text: string; final: boolean }
  /** Conversation engine only. */
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  /** One closed provider socket's usage, for the cost meter. */
  | { type: "usage"; provider: string; model: string; audioMs: number; socketMs: number }
  | { type: "state"; state: EngineState }
  | { type: "error"; code: VoiceErrorCode; retryable: boolean };

export type VoiceEventOf<T extends VoiceEvent["type"]> = Extract<VoiceEvent, { type: T }>;

export interface VoiceEngineStartOptions {
  /** The armed session's one microphone stream (spec decision 11). The caller owns it. */
  readonly stream: MediaStream;
  readonly keyterms: readonly string[];
  /** Aborting it stops the engine, as `stop()` does. */
  readonly signal: AbortSignal;
  /**
   * An AudioContext made during the Arm click (`createAudioContext()`), so it may start. Optional:
   * without one, `start()` makes its own, which only runs if the click's user activation hasn't
   * lapsed. The engine takes ownership and closes it on stop.
   */
  readonly audioContext?: AudioContext;
}

export interface VoiceEngine {
  readonly kind: "cascaded" | "speech_to_speech";
  start(opts: VoiceEngineStartOptions): Promise<void>;
  /** Mid-stream where the provider allows it; otherwise from the next connection. */
  setKeyterms(terms: readonly string[]): Promise<void>;
  /** Ignored in hands-free mode. */
  pushToTalk(down: boolean): void;
  stop(): Promise<void>;
  on(listener: (event: VoiceEvent) => void): () => void;
}
