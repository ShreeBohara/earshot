// Development and end-to-end runs only. lib/capture imports this module only behind
// `process.env.NODE_ENV === "development"`, so it never reaches a production bundle; the Worker
// bundle check looks for FAKE_STT_MARKER to make sure.
import {
  createFakeSttAdapter,
  FAKE_STT_MARKER,
  type FakeSttAdapter,
  type FakeSttTurn,
  fakeCredential,
} from "@earshot/voice/testing";
import {
  FAKE_STATS_GLOBAL,
  FAKE_TIMING_GLOBAL,
  type FakeScenario,
  type FakeTiming,
  type FakeVoice,
  type FakeVoiceStats,
} from "../fake";

/** Each scripted line is spread over this much audio from the start of its press. */
const LINE_MS = 1_200;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The WAV's timing that the fake-microphone eval put on the page, if any. It must say the
 * scenario's lines, in order: otherwise the adapter would hear one script over another's audio.
 */
function wavTiming(scenario: FakeScenario): FakeTiming | undefined {
  const timing = (globalThis as Record<string, unknown>)[FAKE_TIMING_GLOBAL] as
    | FakeTiming
    | undefined;
  if (timing === undefined) return undefined;
  const lines = timing.turns?.map((turn) => normalize(turn.text)) ?? [];
  const expected = scenario.turns.map((turn) => normalize(turn.text));
  if (lines.length !== expected.length || lines.some((line, i) => line !== expected[i])) {
    throw new Error(
      `${FAKE_TIMING_GLOBAL} doesn't say scenario ${scenario.name}'s lines; the eval loaded another script's timing`,
    );
  }
  return timing;
}

export function createFakeVoice(scenario: FakeScenario): FakeVoice {
  const timing = wavTiming(scenario);
  // Push-to-talk: each press is the next turn ("presses" timeline), and its words count from
  // where the press's audio starts, so a WAV's absolute times work as they are.
  const turns: readonly FakeSttTurn[] = timing
    ? timing.turns.map((turn) => ({
        text: turn.text,
        startMs: turn.startMs,
        endMs: turn.endMs,
        words: turn.words,
      }))
    : scenario.turns.map((turn) => ({ text: turn.text, startMs: 0, endMs: LINE_MS }));
  const adapters: FakeSttAdapter[] = [];
  const stats = (): FakeVoiceStats => ({
    timing: timing ? "wav" : "fixed",
    adapters: adapters.map((adapter) => {
      const { samplesReceived, bytesReceived, finalizes, turnsEmitted } = adapter.stats();
      return { samplesReceived, bytesReceived, finalizes, turnsEmitted };
    }),
  });
  (globalThis as Record<string, unknown>)[FAKE_STATS_GLOBAL] = stats;
  const longest = Math.max(LINE_MS, ...turns.map((turn) => turn.endMs - turn.startMs));
  return {
    scenario,
    providers: { speechToText: { provider: "fake", model: "fake" }, llm: scenario.llm },
    turnKey: `${FAKE_STT_MARKER}.placeholder-turn-key`,
    holdMs: longest + 400,
    createAdapter: (fromTurn) => {
      const adapter = createFakeSttAdapter({
        script: { turns: turns.slice(fromTurn) },
        // Push-to-talk ends each line on release; the fake never ends one by itself.
        endpointingMs: 10 * 60 * 1000,
      });
      adapters.push(adapter);
      return adapter;
    },
    credential: () => fakeCredential("assemblyai"),
  };
}
