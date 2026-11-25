// Wires a voice engine to a SessionClient: finals go out as `utterance`, turn ends as `turn_end`
// with this turn's LLM key (or, for a spoken correction armed for the turn, as `correct`, Phase 5
// WP13), and closed speech sockets as `usage`. Partials, levels, and engine
// states stay on the device: they're for the screen, never for SessionDO (spec §4.1).
//
// With a second witness (Phase 4 WP9), each turn whose `turn_end` went out is handed to it with
// the turn's audio (`turn_audio`, which never leaves the browser but for the witness's provider)
// and the span of its finals, and it sends the turn's `witness` message itself.
import type { LlmProvider } from "@earshot/core";
import type { VoiceEngine } from "../engine";
import type { CorrectionDelivery, SendCorrectionInput, SessionClient } from "./client";
import type { SessionWitness } from "./witness";

/**
 * A spoken correction waiting for its turn (Phase 5 WP13): the turn that ends next is its words,
 * sent as `correct` instead of `turn_end`, with no extraction and no key.
 */
export interface ArmedCorrection extends Omit<SendCorrectionInput, "turnId" | "typed"> {
  /** Told how the correction went: the screen shows the new card, or what it couldn't read. */
  readonly settled: (delivery: CorrectionDelivery) => void;
}

export interface EngineBridgeOptions {
  /** The LLM the turn's extraction uses. */
  readonly llm: () => { readonly provider: LlmProvider; readonly model: string };
  /**
   * This turn's LLM key, read from the device when the turn ends (ADR-0009). Undefined when the
   * device holds none: the turn isn't sent, and the screen gets a `missing_key` issue.
   */
  readonly key: () => string | undefined;
  /**
   * The session's second witness, shared by every engine the session runs. Without one, no turn
   * gets a `witness` message.
   */
  readonly witness?: Pick<SessionWitness, "finalHeard" | "turnEnded" | "turnDropped" | "turnAudio">;
  /**
   * The spoken correction armed for the next turn, taken (and so disarmed) when a turn ends, or
   * undefined: then the turn is an ordinary one.
   */
  readonly takeCorrection?: () => ArmedCorrection | undefined;
}

/** Sends the engine's finals, turn ends, and usage through `client`. Returns the unsubscribe. */
export function connectEngine(
  engine: Pick<VoiceEngine, "on">,
  client: Pick<
    SessionClient,
    "sendUtterance" | "sendTurnEnd" | "sendUsage" | "reportIssue" | "sendCorrection"
  >,
  options: EngineBridgeOptions,
): () => void {
  const { witness } = options;
  return engine.on((event) => {
    switch (event.type) {
      case "final":
        client.sendUtterance(event.turnId, event.utterance);
        witness?.finalHeard(event.turnId, event.utterance);
        return;
      case "turn_end": {
        // A spoken correction's words: `correct` instead of `turn_end`, with no key and no witness.
        const correction = options.takeCorrection?.();
        if (correction) {
          witness?.turnDropped(event.turnId);
          const { settled, ...fields } = correction;
          void client.sendCorrection({ ...fields, turnId: event.turnId }).then(settled);
          return;
        }
        const key = options.key();
        if (!key) {
          client.reportIssue({ code: "missing_key", retryable: false });
          witness?.turnDropped(event.turnId);
          return;
        }
        const msgId = client.sendTurnEnd({
          turnId: event.turnId,
          trigger: event.trigger,
          llm: options.llm(),
          key,
        });
        // The witness follows its turn's `turn_end` into the outbox, never ahead of it.
        if (msgId === null) witness?.turnDropped(event.turnId);
        else witness?.turnEnded(event.turnId);
        return;
      }
      case "turn_audio":
        witness?.turnAudio(event.turnId, event.audio);
        return;
      case "usage":
        client.sendUsage(event);
        return;
      default:
        return; // partials, levels, states, errors: the screen's, not SessionDO's
    }
  });
}
