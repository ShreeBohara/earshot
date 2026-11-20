// Development and end-to-end runs only. lib/capture imports this module only behind
// `process.env.NODE_ENV === "development"`, so it never reaches a production bundle; the Worker
// bundle check looks for FAKE_STT_MARKER to make sure.
import { createFakeSttAdapter, FAKE_STT_MARKER, fakeCredential } from "@earshot/voice/testing";
import type { FakeScenario, FakeVoice } from "../fake";

/** Each scripted line is spread over this much audio from the start of its press. */
const LINE_MS = 1_200;

export function createFakeVoice(scenario: FakeScenario): FakeVoice {
  return {
    scenario,
    providers: { speechToText: { provider: "fake", model: "fake" }, llm: scenario.llm },
    turnKey: `${FAKE_STT_MARKER}.placeholder-turn-key`,
    holdMs: LINE_MS + 400,
    createAdapter: (fromTurn) =>
      createFakeSttAdapter({
        script: {
          turns: scenario.turns
            .slice(fromTurn)
            .map((turn) => ({ text: turn.text, startMs: 0, endMs: LINE_MS })),
        },
        // Push-to-talk ends each line on release; the fake never ends one by itself.
        endpointingMs: 10 * 60 * 1000,
      }),
    credential: () => fakeCredential("assemblyai"),
  };
}
