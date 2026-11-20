import { ClientMessage, MAX_MESSAGE_BYTES, type UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import type { SendUsageInput, SendWitnessInput } from "../src/session/client";
import {
  fitWitnessUtterance,
  SessionWitness,
  WITNESS_WINDOW_MARGIN_MS,
  type WitnessSetup,
} from "../src/session/witness";
import { settle } from "../src/testing/fake-socket";
import { createFakeWitness, type FakeWitnessTurn } from "../src/testing/fake-witness";
import type { UnbiasedUtterance } from "../src/witness/runner";
import type { TurnAudio } from "../src/witness/turn-audio";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const turn = (n: number) => `0000000b-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function fakeClient() {
  const sent: (SendWitnessInput | (SendUsageInput & { t: "usage" }))[] = [];
  return {
    sent,
    sendWitness: (input: SendWitnessInput) => {
      sent.push(input);
      return "id";
    },
    sendUsage: (input: SendUsageInput) => {
      sent.push({ t: "usage", ...input });
      return "id";
    },
  };
}

/** `ms` of audio at `startMs` on the session's clock. */
function audioOf(startMs: number, ms: number, pcm = true): TurnAudio {
  return { startMs, durationMs: ms, pcm: pcm ? new Int16Array(ms * 16) : null };
}

function final(startMs: number, endMs: number): Pick<UtteranceFinalV2, "startMs" | "endMs"> {
  return { startMs, endMs };
}

function harness(
  script: readonly FakeWitnessTurn[],
  setup: "on" | "off" | "no_key" = "on",
  gate?: (index: number) => Promise<void>,
) {
  const clock = new ManualClock();
  const client = fakeClient();
  const runner = createFakeWitness({
    script: { turns: script },
    createId: counterIds(),
    ...(gate ? { gate } : {}),
  });
  const witnessSetup: WitnessSetup =
    setup === "on"
      ? { status: "on", runner }
      : { status: setup, provider: "groq", model: "whisper-large-v3-turbo" };
  const witness = new SessionWitness({ client, setup: () => witnessSetup, clock });
  return { clock, client, runner, witness };
}

/** One turn as the bridge reports it: finals, the queued turn_end, then the engine's audio. */
function turnOf(h: ReturnType<typeof harness>, id: string, startMs: number, ms = 1_800) {
  h.witness.finalHeard(id, final(startMs, startMs + ms - 200));
  h.witness.turnEnded(id);
  h.witness.turnAudio(id, audioOf(startMs, ms + 200));
}

describe("SessionWitness", () => {
  it("runs the witness on a turn's audio once its turn_end is queued, then sends the witness and its usage", async () => {
    const h = harness([{ text: "Debrief from Atmo Systems", latencyMs: 640 }]);
    turnOf(h, turn(1), 5_000);
    await h.witness.idle();
    expect(h.runner.calls).toEqual([{ samples: 2_000 * 16, turnStartMs: 5_000 }]);
    expect(h.client.sent).toHaveLength(2);
    const [witness, usage] = h.client.sent;
    expect(witness).toMatchObject({
      turnId: turn(1),
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "transcribed",
      latencyMs: 640,
      utterance: { text: "Debrief from Atmo Systems", witness: "unbiased", startMs: 5_000 },
    });
    // The usage the price table bills: the audio sent (10 s at least, in the table), no socket.
    expect(usage).toEqual({
      t: "usage",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      audioMs: 2_000,
      socketMs: 0,
    });
    // What goes out is what SessionDO parses.
    const message = { t: "witness", msgId: "0193a000-0000-7000-8000-000000000001", ...witness };
    expect(ClientMessage.safeParse(message).success).toBe(true);
  });

  it("sends witnesses in turn order, whichever the provider answers first", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = harness([{ text: "first turn words" }, { text: "second turn words" }], "on", (i) =>
      i === 0 ? firstHeld : Promise.resolve(),
    );
    turnOf(h, turn(1), 0);
    turnOf(h, turn(2), 3_000);
    await settle();
    expect(h.runner.calls).toHaveLength(2); // both ran at once
    expect(h.client.sent).toEqual([]); // the second waits for the first
    releaseFirst();
    await h.witness.idle();
    expect(
      h.client.sent.flatMap((message) => ("turnId" in message ? [message.turnId] : [])),
    ).toEqual([turn(1), turn(2)]);
  });

  it("says why a turn has no witness: off, no key here, too long, or the provider's failure", async () => {
    const off = harness([], "off");
    turnOf(off, turn(1), 0);
    const noKey = harness([], "no_key");
    turnOf(noKey, turn(1), 0);
    const tooLong = harness([{ text: "never asked" }]);
    tooLong.witness.finalHeard(turn(1), final(0, 1_000));
    tooLong.witness.turnEnded(turn(1));
    tooLong.witness.turnAudio(turn(1), audioOf(0, 121_000, false));
    const failed = harness([{ failure: "rate_limited", latencyMs: 30 }, { failure: "no_key" }]);
    turnOf(failed, turn(1), 0);
    turnOf(failed, turn(2), 3_000);
    for (const h of [off, noKey, tooLong, failed]) await h.witness.idle();
    expect(off.client.sent).toEqual([
      {
        turnId: turn(1),
        provider: "groq",
        model: "whisper-large-v3-turbo",
        outcome: "skipped",
        reason: "off",
      },
    ]);
    expect(noKey.client.sent).toMatchObject([{ outcome: "skipped", reason: "no_key" }]);
    expect(tooLong.client.sent).toMatchObject([{ outcome: "skipped", reason: "too_long" }]);
    expect(tooLong.runner.calls).toEqual([]);
    expect(failed.client.sent).toMatchObject([
      { turnId: turn(1), outcome: "failed", reason: "rate_limited", latencyMs: 30 },
      { turnId: turn(2), outcome: "skipped", reason: "no_key" },
    ]);
  });

  it("sends nothing for a tap, a turn the biased stream heard nothing of, one with no audio, or one whose turn_end never went out", async () => {
    const h = harness([{ text: "unused" }]);
    // A tap: under a second of audio.
    h.witness.finalHeard(turn(1), final(0, 400));
    h.witness.turnEnded(turn(1));
    h.witness.turnAudio(turn(1), audioOf(0, 900));
    // Silence: no final.
    h.witness.turnEnded(turn(2));
    h.witness.turnAudio(turn(2), audioOf(2_000, 3_000));
    // A late final's turn, with no audio of its own.
    h.witness.finalHeard(turn(3), final(6_000, 7_000));
    h.witness.turnEnded(turn(3));
    h.witness.turnAudio(turn(3), null);
    // No LLM key: its turn_end was never sent, so neither is its witness.
    h.witness.finalHeard(turn(4), final(9_000, 10_000));
    h.witness.turnDropped(turn(4));
    h.witness.turnAudio(turn(4), audioOf(9_000, 2_000));
    await h.witness.idle();
    expect(h.client.sent).toEqual([]);
    expect(h.runner.calls).toEqual([]);
  });

  it("lets a turn go when its audio never comes, so the turns after it aren't held up", async () => {
    const h = harness([{ text: "second turn words" }]);
    h.witness.finalHeard(turn(1), final(0, 1_000));
    h.witness.turnEnded(turn(1)); // its turn_audio never arrives
    turnOf(h, turn(2), 3_000);
    await settle();
    expect(h.client.sent).toEqual([]);
    await h.clock.advance(15_000);
    await h.witness.idle();
    expect(h.client.sent).toMatchObject([
      { turnId: turn(2), outcome: "transcribed" },
      { t: "usage", provider: "groq" },
    ]);
  });

  it("sends nothing more once disposed, requests in flight included", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([{ text: "words" }], "on", () => held);
    turnOf(h, turn(1), 0);
    h.witness.dispose();
    release();
    await h.witness.idle();
    await settle();
    expect(h.client.sent).toEqual([]);
  });
});

describe("fitWitnessUtterance", () => {
  const unbiased = (words: [string, number, number][], text?: string): UnbiasedUtterance => ({
    utteranceId: "0000000c-0000-7000-8000-000000000001",
    text: text ?? words.map(([w]) => w).join(" "),
    confidence: 0.8,
    words: words.map(([w, startMs, endMs]) => ({ w, startMs, endMs, confidence: 0.8 })),
    startMs: words[0]?.[1] ?? 0,
    endMs: words.at(-1)?.[2] ?? 0,
    witness: "unbiased",
  });

  it("keeps the words within 0.9 s of the turn's own, so SessionDO's 1 s check can't refuse it", () => {
    const window = { startMs: 10_000, endMs: 12_000 };
    const fitted = fitWitnessUtterance(
      unbiased([
        ["Thank", 8_000, 8_300], // before the turn's words by more than the margin
        ["Atmo", 10_100, 10_400],
        ["Systems", 10_450, 10_900],
        ["you.", 12_000 + WITNESS_WINDOW_MARGIN_MS + 50, 12_000 + WITNESS_WINDOW_MARGIN_MS + 400],
      ]),
      window,
    );
    expect(fitted).toMatchObject({ text: "Atmo Systems", startMs: 10_100, endMs: 10_900 });
    expect(fitted?.words?.map((word) => word.w)).toEqual(["Atmo", "Systems"]);
    // Nothing within the window: nothing to compare.
    expect(fitWitnessUtterance(unbiased([["you.", 20_000, 20_400]]), window)).toBeNull();
    // Untouched when every word is inside, punctuation and all.
    const inside = unbiased([["Atmo", 10_100, 10_400]], "Atmo.");
    expect(fitWitnessUtterance(inside, window)).toEqual(inside);
  });

  it("keeps a transcript with no words inside the bounds, and its text within 4,000 characters", () => {
    const long = `${"word ".repeat(1_000)}end`;
    const fitted = fitWitnessUtterance(
      {
        ...unbiased([]),
        text: long,
        words: undefined,
        startMs: 0,
        endMs: 99_000,
      } as UnbiasedUtterance,
      { startMs: 5_000, endMs: 6_000 },
    );
    expect(fitted?.text.length).toBeLessThanOrEqual(4_000);
    expect(fitted?.text.endsWith("word")).toBe(true);
    expect(fitted).toMatchObject({ startMs: 4_100, endMs: 6_900 });
  });

  it("drops the word timings that would overflow a 64 KiB frame, keeping the text", () => {
    // 1,500 one-letter words: 2,999 characters of text, but about 80 KB of timings.
    const words: [string, number, number][] = [];
    for (let i = 0; i < 1_500; i++) words.push(["a", 1_000 + i * 5, 1_004 + i * 5]);
    const fitted = fitWitnessUtterance(unbiased(words), { startMs: 1_000, endMs: 9_000 });
    expect(fitted?.words).toBeUndefined();
    expect(fitted?.text.length).toBe(2_999);
    expect(JSON.stringify(fitted).length).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
