import { UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import type { VoiceEvent, VoiceEventOf } from "../src/engine";
import { createDebriefEngine, type DebriefEngineOptions } from "../src/engines/debrief";
import { VoiceError } from "../src/errors";
import { FakeCaptureSource } from "../src/testing/fake-capture";
import { createFakeSttAdapter, type FakeSttOptions, fakeCredential } from "../src/testing/fake-stt";
import type { HandsFreeVadFactory } from "../src/vad/hands-free";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const SCRIPT: FakeSttOptions["script"] = {
  turns: [
    { text: "Acme renewed for two years", startMs: 1_000, endMs: 2_600 },
    { text: "Send the proposal Friday", startMs: 5_000, endMs: 6_400 },
    { text: "Call Dana about pricing", startMs: 9_000, endMs: 10_400 },
  ],
};

function turnIds(): () => string {
  let next = 0;
  return () => `0000000a-0000-7000-8000-${(++next).toString(16).padStart(12, "0")}`;
}

function fakeVad() {
  let callbacks: Parameters<HandsFreeVadFactory>[0] | undefined;
  const calls: string[] = [];
  const factory: HandsFreeVadFactory = async (options) => {
    callbacks = options;
    calls.push("load");
    return {
      start: async () => void calls.push("start"),
      pause: async () => void calls.push("pause"),
      destroy: async () => void calls.push("destroy"),
    };
  };
  return {
    factory,
    calls,
    speechStart: () => callbacks?.onSpeechStart(),
    speechEnd: () => callbacks?.onSpeechEnd(),
  };
}

function harness(
  options: Partial<DebriefEngineOptions> & {
    fake?: Partial<FakeSttOptions>;
    credential?: () => Promise<ReturnType<typeof fakeCredential>>;
  } = {},
) {
  const clock = new ManualClock();
  const capture = new FakeCaptureSource();
  const vad = fakeVad();
  const fake = createFakeSttAdapter({
    script: SCRIPT,
    clock,
    createId: counterIds(),
    ...options.fake,
  });
  let credentials = 0;
  const { fake: _, credential, ...engineOptions } = options;
  const engine = createDebriefEngine({
    adapter: fake,
    getCredential: async () => {
      credentials += 1;
      return credential ? credential() : fakeCredential();
    },
    capture: capture.factory(),
    vad: vad.factory,
    clock,
    random: () => 0.5,
    createId: turnIds(),
    ...engineOptions,
  });
  const events: VoiceEvent[] = [];
  engine.on((event) => events.push(event));
  const abort = new AbortController();
  return {
    engine,
    capture,
    fake,
    clock,
    vad,
    events,
    abort,
    credentials: () => credentials,
    start: () =>
      engine.start({
        stream: {} as MediaStream,
        keyterms: ["Acme", "Initech"],
        signal: abort.signal,
      }),
    /** Captures `ms` of audio in real time: a tone, or silence with amplitude 0. */
    async talk(ms: number, amplitude = 0.3) {
      for (let done = 0; done < ms; done += 32) {
        capture.speak(Math.min(32, ms - done), amplitude);
        await clock.advance(Math.min(32, ms - done));
      }
    },
    of<T extends VoiceEvent["type"]>(type: T): VoiceEventOf<T>[] {
      return events.filter((event): event is VoiceEventOf<T> => event.type === type);
    },
    states: () => events.flatMap((event) => (event.type === "state" ? [event.state] : [])),
    /** Finals, turn ends, and usage, in order, without the noise. */
    story: () =>
      events.flatMap((event) => {
        if (event.type === "final")
          return [`final ${event.turnId.slice(-1)} ${event.utterance.text}`];
        if (event.type === "turn_end")
          return [`turn_end ${event.turnId.slice(-1)} ${event.trigger}`];
        if (event.type === "usage") return [`usage ${event.provider}`];
        if (event.type === "error") return [`error ${event.code}`];
        return [];
      }),
  };
}

type Harness = ReturnType<typeof harness>;

/** One push-to-talk turn: press, speak `ms` in real time, release, and let the finals land. */
async function press(h: Harness, ms: number) {
  h.engine.pushToTalk(true);
  await h.talk(ms);
  h.engine.pushToTalk(false);
  await h.clock.advance(0);
}

describe("push-to-talk", () => {
  it("captures, transcribes, and ends a turn: partials, a final, then turn_end", async () => {
    const h = harness();
    await h.start();
    expect(h.states()).toEqual(["starting", "armed"]);
    await press(h, 1_800);
    expect(h.states()).toEqual(["starting", "armed", "recording", "finalizing", "armed"]);
    expect(h.of("partial").map((event) => event.text)).toContain("Acme renewed for two years");
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 ptt_release"]);
    const [final] = h.of("final");
    expect(UtteranceFinalV2.parse(final?.utterance)).toEqual(final?.utterance);
    expect(final?.turnId).toBe(h.of("turn_end")[0]?.turnId);
    expect(h.credentials()).toBe(1);
    // The provider got the speech stream: 1,800 ms, the release's partial frame, and padding.
    expect(h.fake.stats().samplesReceived).toBeGreaterThanOrEqual(1_800 * 16);
  });

  it("emits mic levels for the orb from every frame, pressed or not", async () => {
    const h = harness();
    await h.start();
    await h.talk(320, 0.3);
    const levels = h.of("level");
    expect(levels).toHaveLength(10);
    expect(levels.every((event) => event.mic > 0.5 && event.agent === 0)).toBe(true);
    await h.talk(320, 0);
    expect(h.of("level").at(-1)?.mic).toBe(0);
    expect(h.fake.stats().samplesReceived).toBe(0); // nothing is sent until a press
  });

  it("reuses one socket across presses, with one credential", async () => {
    const h = harness();
    await h.start();
    await press(h, 1_800);
    await h.clock.advance(3_000);
    await press(h, 1_600);
    expect(h.story()).toEqual([
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
      "final 2 Send the proposal Friday",
      "turn_end 2 ptt_release",
    ]);
    expect(h.fake.stats().connects).toBe(1);
    expect(h.credentials()).toBe(1);
  });

  it("keeps an idle socket alive, closes it after 20 s, reports its usage, and reopens on the next press", async () => {
    const h = harness();
    await h.start();
    await press(h, 1_800);
    await h.clock.advance(19_000);
    expect(h.fake.stats().keepAlives).toBe(3);
    expect(h.of("usage")).toHaveLength(0);
    await h.clock.advance(1_000);
    // Open from the first frame after the press (32 ms) until 20 s after the release (21,800 ms).
    expect(h.of("usage")).toEqual([
      { type: "usage", provider: "fake", model: "fake", audioMs: 1_812, socketMs: 21_768 },
    ]);
    await press(h, 1_600);
    expect(h.fake.stats().connects).toBe(2);
    expect(h.credentials()).toBe(2); // a fresh credential for every connect
    expect(h.story().at(-1)).toBe("turn_end 2 ptt_release");
  });

  it("buffers speech while the first connect is in flight, so no first word is clipped", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      credential: () =>
        new Promise((resolve) => {
          release = () => resolve(fakeCredential());
        }),
    });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(1_000);
    expect(h.fake.stats().connects).toBe(0);
    release?.();
    await h.talk(800);
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 ptt_release"]);
  });

  it("ends a silent press at once, without waiting on the provider", async () => {
    // A provider that heard nothing: no partials, so no turn is open, and no voiced audio went out.
    const h = harness({ fake: { script: { turns: [] } } });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(800, 0);
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual(["turn_end 1 ptt_release"]);
    expect(h.fake.stats().finalizes).toBe(1);
  });

  it("waits for a slow final rather than ending the turn early", async () => {
    const h = harness({ fake: { faults: { finalDelayMs: 900 } } });
    await h.start();
    await press(h, 1_800);
    expect(h.story()).toEqual([]);
    expect(h.engine.state).toBe("finalizing");
    await h.clock.advance(900);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 ptt_release"]);
  });

  it("keeps each press's final with its own turn when the next press ends before it lands", async () => {
    const h = harness({ fake: { faults: { finalDelayMs: 900 } } });
    await h.start();
    await press(h, 320);
    await press(h, 320);
    // The first press is still waiting on its final: the second release doesn't end it early.
    expect(h.story()).toEqual([]);
    await h.clock.advance(2_000);
    // 320 ms presses carry only each script turn's first word; what matters is which turn gets it.
    expect(h.story()).toEqual([
      "final 1 Acme",
      "turn_end 1 ptt_release",
      "final 2 Send",
      "turn_end 2 ptt_release",
    ]);
  });

  it("gives up waiting after the finalize timeout, and delivers a late final as its own turn", async () => {
    const h = harness({ fake: { faults: { finalDelayMs: 4_000 } } });
    await h.start();
    await press(h, 1_800);
    await h.clock.advance(1_500);
    expect(h.story()).toEqual(["turn_end 1 ptt_release"]);
    await h.clock.advance(2_500);
    expect(h.story()).toEqual([
      "turn_end 1 ptt_release",
      "final 2 Acme renewed for two years",
      "turn_end 2 manual",
    ]);
  });

  it("doesn't send mic audio while muted (autoMute reads a ref, synchronously)", async () => {
    let muted = true;
    const h = harness({ isMuted: () => muted });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(640);
    expect(h.fake.stats().samplesReceived).toBe(0);
    muted = false;
    await h.talk(640);
    expect(h.fake.stats().samplesReceived).toBe(640 * 16);
  });
});

describe("drops and reconnects", () => {
  it("replays buffered audio after a mid-turn drop, so every word is transcribed once", async () => {
    const h = harness({ fake: { faults: { dropAtMs: [1_200] } } });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(1_216);
    expect(h.engine.state).toBe("reconnecting");
    await h.talk(600);
    expect(h.engine.state).toBe("recording");
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual([
      "usage fake",
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
    ]);
    expect(h.fake.stats()).toMatchObject({ connects: 2, drops: 1, baseOffsetsMs: [0, 0] });
    expect(h.credentials()).toBe(2);
    expect(h.states()).toContain("reconnecting");
  });

  it("replays from the end of the last turn, never re-sending a finished one", async () => {
    const h = harness({ fake: { faults: { dropAtMs: [2_400] } } });
    await h.start();
    await press(h, 1_800);
    const turnOneEnd = h.of("turn_end").length;
    expect(turnOneEnd).toBe(1);
    h.engine.pushToTalk(true);
    await h.talk(1_600);
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual([
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
      "usage fake",
      "final 2 Send the proposal Friday",
      "turn_end 2 ptt_release",
    ]);
    // The second socket started where turn 1's audio ended, not at the start of the stream.
    const [, resumedAt] = h.fake.stats().baseOffsetsMs;
    expect(resumedAt).toBeGreaterThanOrEqual(1_800);
    expect(resumedAt).toBeLessThanOrEqual(2_400);
  });

  it("re-sends a release's finalize on the new socket when the drop comes after it", async () => {
    const h = harness({ fake: { faults: { dropAtMs: [1_810] } } });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(1_800);
    h.engine.pushToTalk(false); // the flush pushes the stream past 1,810: the drop eats the finalize
    await h.clock.advance(0);
    await h.clock.advance(500);
    expect(h.story()).toEqual([
      "usage fake",
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
    ]);
    expect(h.fake.stats().finalizes).toBe(1);
  });

  it("doesn't reconnect a socket that dropped while idle, until the next press", async () => {
    const h = harness();
    await h.start();
    await press(h, 1_800);
    // Drop the idle socket from the provider's side.
    const connection = await (async () => {
      const usage = h.of("usage").length;
      await h.engine.setKeyterms(["Acme"]); // no-op on the fake, but proves the socket is open
      return usage;
    })();
    expect(connection).toBe(0);
    await h.clock.advance(20_000);
    expect(h.fake.stats().connects).toBe(1);
    await press(h, 1_600);
    expect(h.fake.stats().connects).toBe(2);
  });

  it("waits out a rate limit before reconnecting, then sends what it buffered", async () => {
    const h = harness({ fake: { faults: { refuseConnects: { count: 1, code: "rate_limited" } } } });
    await h.start();
    h.engine.pushToTalk(true); // the refusal comes at once; the retry waits 12 s
    await h.talk(1_800);
    expect(h.fake.stats().connects).toBe(0);
    await h.talk(10_000, 0); // 11,800 ms
    expect(h.fake.stats().connects).toBe(0);
    await h.talk(400, 0); // 12,200 ms
    expect(h.fake.stats().connects).toBe(1);
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 ptt_release"]);
  });
});

describe("credentials and failures", () => {
  it("stops at once on a refused key, ends the turn, and tries again on the next action", async () => {
    let calls = 0;
    const h = harness({
      credential: async () => {
        calls += 1;
        throw new VoiceError("provider_rejected", "the key was refused");
      },
    });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(320);
    expect(h.story()).toEqual(["error provider_rejected"]);
    expect(calls).toBe(1);
    h.engine.pushToTalk(false);
    await h.clock.advance(200);
    expect(h.story()).toEqual([
      "error provider_rejected",
      "error provider_rejected",
      "turn_end 1 ptt_release",
    ]);
    expect(h.of("error").every((event) => event.retryable === false)).toBe(true);
    expect(h.engine.state).toBe("armed");
  });

  it("retries a failing mint with backoff, then gives up retryably", async () => {
    let calls = 0;
    const h = harness({
      maxConnectAttempts: 3,
      credential: async () => {
        calls += 1;
        throw new VoiceError("credential_failed", "the token route failed", { retryable: true });
      },
    });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(5_000, 0);
    expect(calls).toBe(3);
    expect(h.of("error")).toEqual([{ type: "error", code: "credential_failed", retryable: true }]);
  });

  it("reports a capture failure at start and stops", async () => {
    const capture = new FakeCaptureSource();
    const engine = createDebriefEngine({
      adapter: createFakeSttAdapter({ script: SCRIPT }),
      getCredential: async () => fakeCredential(),
      capture: capture.factory(new Error("no AudioWorklet")),
    });
    const events: VoiceEvent[] = [];
    engine.on((event) => events.push(event));
    await expect(
      engine.start({
        stream: {} as MediaStream,
        keyterms: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "audio_unavailable" });
    expect(events).toEqual([
      { type: "state", state: "starting" },
      { type: "error", code: "audio_unavailable", retryable: false },
      { type: "state", state: "stopped" },
    ]);
  });
});

describe("keyterms", () => {
  it("carries the session's keyterms on connect, and updates them mid-stream", async () => {
    const h = harness();
    await h.start();
    await h.engine.setKeyterms(["Acme", "Globex"]); // before any socket: next connect
    h.engine.pushToTalk(true);
    await h.talk(320);
    await h.engine.setKeyterms(["Hooli"]);
    expect(h.fake.stats().connectKeyterms).toEqual([["Acme", "Globex"]]);
    expect(h.fake.stats().keytermUpdates).toEqual([["Hooli"]]);
  });

  it("rejects an update the provider refuses, and reports it", async () => {
    const h = harness({ fake: { faults: { rejectKeyterms: true } } });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(320);
    await expect(h.engine.setKeyterms(["X"])).rejects.toMatchObject({ code: "keyterms_rejected" });
    expect(h.of("error")).toEqual([{ type: "error", code: "keyterms_rejected", retryable: false }]);
  });
});

describe("stopping", () => {
  it("finishes the turn in progress, closes the socket with its usage, then stops", async () => {
    const h = harness();
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(1_800);
    const stopping = h.engine.stop();
    expect(h.engine.stop()).toBe(stopping);
    await h.clock.advance(0);
    await h.clock.advance(2_000);
    await stopping;
    expect(h.story()).toEqual([
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
      "usage fake",
    ]);
    expect(h.states().at(-1)).toBe("stopped");
    expect(h.capture.closed).toBe(true);
    h.engine.pushToTalk(true); // ignored once stopped
    expect(h.engine.state).toBe("stopped");
  });

  it("stops when the start signal aborts", async () => {
    const h = harness();
    await h.start();
    h.abort.abort();
    await h.clock.advance(0);
    expect(h.engine.state).toBe("stopped");
    expect(h.capture.closed).toBe(true);
  });
});

describe("hands-free", () => {
  it("streams on arming, lets the provider end turns, and follows the VAD for state", async () => {
    const h = harness({ fake: { timeline: "absolute", endpointingMs: 600 } });
    await h.start();
    await h.engine.setHandsFree(true);
    expect(h.vad.calls).toEqual(["load", "start"]);
    h.engine.pushToTalk(true); // ignored in hands-free
    expect(h.engine.state).toBe("armed");
    await h.talk(900, 0);
    h.vad.speechStart();
    expect(h.engine.state).toBe("recording");
    await h.talk(2_400);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 provider_eot"]);
    h.vad.speechEnd();
    expect(h.engine.state).toBe("armed");
    expect(h.fake.stats().connects).toBe(1);
  });

  it("closes the socket after a long silence and wakes, with pre-roll, when speech returns", async () => {
    const h = harness({ fake: { timeline: "absolute", endpointingMs: 600 } });
    await h.start();
    await h.engine.setHandsFree(true);
    h.vad.speechStart();
    await h.talk(3_300);
    h.vad.speechEnd();
    const beforeSleep = h.fake.stats().samplesReceived;
    await h.talk(20_000, 0);
    expect(h.of("usage")).toHaveLength(1);
    const asleepAt = h.fake.stats().samplesReceived;
    await h.talk(3_000, 0);
    expect(h.fake.stats().samplesReceived).toBe(asleepAt); // nothing streams while asleep
    expect(asleepAt).toBeGreaterThan(beforeSleep);
    h.vad.speechStart();
    await h.talk(320);
    expect(h.fake.stats().connects).toBe(2);
    // The new socket starts where the old one's audio ended and gets the 1 s pre-roll first.
    const [, resumedAt] = h.fake.stats().baseOffsetsMs;
    expect(resumedAt).toBe(asleepAt / 16);
    expect(h.fake.stats().samplesReceived - asleepAt).toBeGreaterThanOrEqual(16_000);
  });

  it("never streams audio captured while muted, not even as a wake's pre-roll", async () => {
    let muted = false;
    const h = harness({ isMuted: () => muted, fake: { timeline: "absolute", endpointingMs: 600 } });
    await h.start();
    await h.engine.setHandsFree(true);
    h.vad.speechStart();
    await h.talk(3_300);
    h.vad.speechEnd();
    await h.talk(20_000, 0); // asleep after the long silence
    const asleepAt = h.fake.stats().samplesReceived;
    muted = true; // the agent speaks, and the VAD hears it
    await h.talk(1_000);
    h.vad.speechStart();
    await h.talk(320);
    expect(h.fake.stats().samplesReceived).toBe(asleepAt);
    muted = false;
    await h.talk(640);
    expect(h.fake.stats().samplesReceived).toBe(asleepAt + 640 * 16);
  });

  it("replays silence, not muted audio, when it wakes after the mute ends", async () => {
    let muted = false;
    const h = harness({ isMuted: () => muted, fake: { timeline: "absolute", endpointingMs: 600 } });
    const sent: Int16Array[] = [];
    const original = h.fake.connect.bind(h.fake);
    h.fake.connect = async (options) => {
      const connection = await original(options);
      const send = connection.send.bind(connection);
      connection.send = (pcm) => {
        sent.push(pcm.slice());
        send(pcm);
      };
      return connection;
    };
    await h.start();
    await h.engine.setHandsFree(true);
    h.vad.speechStart();
    await h.talk(3_300);
    h.vad.speechEnd();
    await h.talk(20_000, 0);
    sent.length = 0;
    muted = true;
    await h.talk(1_000); // loud, but muted
    muted = false;
    h.vad.speechStart(); // wakes with the 1 s pre-roll
    await h.clock.advance(0);
    const preRoll = sent.flatMap((pcm) => Array.from(pcm)).slice(0, 16_000);
    expect(preRoll.length).toBeGreaterThan(0);
    expect(preRoll.every((sample) => sample === 0)).toBe(true);
  });

  it("keeps streaming without a silence cutoff when the VAD can't load", async () => {
    const h = harness({
      fake: { timeline: "absolute" },
      vad: async () => {
        throw new Error("onnxruntime failed");
      },
    });
    await h.start();
    await h.engine.setHandsFree(true);
    expect(h.of("error")).toEqual([{ type: "error", code: "vad_unavailable", retryable: true }]);
    await h.talk(25_000, 0);
    expect(h.of("usage")).toHaveLength(0);
    // Everything but the last partial 64 ms message, which waits for the next frame.
    expect(h.fake.stats().samplesReceived).toBe(Math.floor((25_000 * 16) / 1_024) * 1_024);
  });

  it("finalizes the hands-free turn in progress when switching back to push-to-talk", async () => {
    const h = harness({ fake: { timeline: "absolute", endpointingMs: 5_000 } });
    await h.start();
    await h.engine.setHandsFree(true);
    h.vad.speechStart();
    await h.talk(2_800);
    await h.engine.setHandsFree(false);
    await h.clock.advance(0);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 manual"]);
    expect(h.vad.calls).toContain("pause");
    expect(h.engine.mode).toBe("push_to_talk");
  });

  it("starts in hands-free when created that way", async () => {
    const h = harness({ mode: "hands_free", fake: { timeline: "absolute" } });
    await h.start();
    await h.clock.advance(0);
    expect(h.fake.stats().connects).toBe(1);
    expect(h.vad.calls).toEqual(["load", "start"]);
  });
});

describe("the session audio clock", () => {
  it("starts at audioClockStartMs: finals, words, partials, and socket offsets are on it", async () => {
    // 90 s: past the ring's 60 s, so even the first sample lands partway into the ring.
    const h = harness({ audioClockStartMs: 90_000 });
    expect(h.engine.audioClockMs).toBe(90_000);
    await h.start();
    await press(h, 1_800);
    expect(h.story()).toEqual(["final 1 Acme renewed for two years", "turn_end 1 ptt_release"]);
    const utterance = h.of("final")[0]?.utterance;
    // The script's first turn, spread from the start of the press, which is at 90,000 ms.
    expect(utterance).toMatchObject({ startMs: 90_000, endMs: 91_541 });
    expect(utterance?.words?.map((word) => [word.w, word.startMs, word.endMs])).toEqual([
      ["Acme", 90_000, 90_237],
      ["renewed", 90_296, 90_711],
      ["for", 90_770, 90_948],
      ["two", 91_007, 91_185],
      ["years", 91_244, 91_541],
    ]);
    expect(h.of("partial")[0]).toMatchObject({ text: "Acme", startMs: 90_000, endMs: 90_237 });
    expect(h.fake.stats().baseOffsetsMs).toEqual([90_000]);
    // The press's 1,800 ms, and the 12 ms of silence that padded its flushed remainder to 20 ms.
    expect(h.engine.audioClockMs).toBe(91_812);
    expect(() => harness({ audioClockStartMs: -1 })).toThrow(RangeError);
  });

  it("replays after drops from the right place on it: the press's start, then the last turn's end", async () => {
    const h = harness({
      audioClockStartMs: 90_000,
      fake: { faults: { dropAtMs: [91_200, 92_600] } },
    });
    await h.start();
    h.engine.pushToTalk(true);
    await h.talk(1_216); // the first drop: the next socket replays the press from 90,000 ms
    await h.talk(600);
    h.engine.pushToTalk(false);
    await h.clock.advance(0);
    await press(h, 1_600); // the second drop: the next socket starts where turn 1's audio ended
    expect(h.story()).toEqual([
      "usage fake",
      "final 1 Acme renewed for two years",
      "turn_end 1 ptt_release",
      "usage fake",
      "final 2 Send the proposal Friday",
      "turn_end 2 ptt_release",
    ]);
    // Turn 1 was 1,816 ms of audio from 90,000 ms; nothing is replayed from before either.
    expect(h.fake.stats().baseOffsetsMs).toEqual([90_000, 90_000, 91_816]);
  });
});
