// Wires a voice engine to a SessionClient: finals go out as `utterance`, turn ends as `turn_end`
// with this turn's LLM key, and closed speech sockets as `usage`. Partials, levels, and engine
// states stay on the device: they're for the screen, never for SessionDO (spec §4.1).
import type { LlmProvider } from "@earshot/core";
import type { VoiceEngine } from "../engine";
import type { SessionClient } from "./client";

export interface EngineBridgeOptions {
  /** The LLM the turn's extraction uses. */
  readonly llm: () => { readonly provider: LlmProvider; readonly model: string };
  /**
   * This turn's LLM key, read from the device when the turn ends (ADR-0009). Undefined when the
   * device holds none: the turn isn't sent, and the screen gets a `missing_key` issue.
   */
  readonly key: () => string | undefined;
}

/** Sends the engine's finals, turn ends, and usage through `client`. Returns the unsubscribe. */
export function connectEngine(
  engine: Pick<VoiceEngine, "on">,
  client: Pick<SessionClient, "sendUtterance" | "sendTurnEnd" | "sendUsage" | "reportIssue">,
  options: EngineBridgeOptions,
): () => void {
  return engine.on((event) => {
    switch (event.type) {
      case "final":
        client.sendUtterance(event.turnId, event.utterance);
        return;
      case "turn_end": {
        const key = options.key();
        if (!key) {
          client.reportIssue({ code: "missing_key", retryable: false });
          return;
        }
        client.sendTurnEnd({
          turnId: event.turnId,
          trigger: event.trigger,
          llm: options.llm(),
          key,
        });
        return;
      }
      case "usage":
        client.sendUsage(event);
        return;
      default:
        return; // partials, levels, states, errors: the screen's, not SessionDO's
    }
  });
}
