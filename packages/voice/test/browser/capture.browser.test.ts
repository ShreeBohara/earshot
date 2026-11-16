// What only a browser can show: the pcm16-capture AudioWorklet resampling on the audio thread,
// getUserMedia against Chrome's fake microphone, the Debrief engine end to end against the fake
// adapter (WP4's done-when), and vad-web loading Silero v6 from local files with onnxruntime-web
// single-threaded in a page that isn't cross-origin isolated. Chromium runs it with
// --use-fake-device-for-media-stream (see vitest.config.ts). Nothing leaves the machine.
import vadModelUrl from "@ricky0123/vad-web/dist/silero_vad_v6.onnx?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CaptureFrame,
  type CaptureSource,
  createAudioContext,
  startCaptureGraph,
} from "../../src/capture/graph";
import { MIC_CONSTRAINTS, openMicrophone } from "../../src/capture/microphone";
import type { VoiceEvent } from "../../src/engine";
import { createDebriefEngine } from "../../src/engines/debrief";
import { createFakeSttAdapter, fakeCredential } from "../../src/testing/fake-stt";
import { loadHandsFreeVad } from "../../src/vad/hands-free";

const WORKLET_URL = new URL("../../src/capture/worklet.ts", import.meta.url);
const dirOf = (url: string) => url.slice(0, url.lastIndexOf("/") + 1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A tone as a MediaStream, through an AudioContext of its own. */
function toneStream(frequency: number, amplitude = 0.5) {
  const context = new AudioContext();
  const oscillator = new OscillatorNode(context, { frequency });
  const gain = new GainNode(context, { gain: amplitude });
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  cleanups.push(() => context.close());
  return destination.stream;
}

async function collectFrames(source: CaptureSource, ms: number) {
  const frames: CaptureFrame[] = [];
  const stop = source.onFrame((frame) => frames.push(frame));
  await sleep(ms);
  stop();
  return frames;
}

function zeroCrossingsPerSecond(frames: readonly CaptureFrame[]) {
  const samples = frames.slice(4).flatMap((frame) => [...frame.pcm]);
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] ?? 0) < 0 !== (samples[i] ?? 0) < 0) crossings += 1;
  }
  return (crossings * 16_000) / samples.length;
}

describe("the capture graph in Chromium", () => {
  it("runs at the context's native rate and emits 16 kHz, 512-sample PCM16 frames", async () => {
    const context = createAudioContext();
    const source = await startCaptureGraph({
      stream: toneStream(1_000),
      audioContext: context,
      workletUrl: WORKLET_URL,
    });
    cleanups.push(() => source.close());
    expect(context.sampleRate).toBeGreaterThanOrEqual(44_100);
    const frames = await collectFrames(source, 1_000);
    expect(frames.length).toBeGreaterThan(20);
    expect(frames.every((frame) => frame.pcm.length === 512 && !frame.flush)).toBe(true);
    // A 1 kHz tone crosses zero 2,000 times a second at any output rate, if the rate is right.
    expect(zeroCrossingsPerSecond(frames)).toBeGreaterThan(1_900);
    expect(zeroCrossingsPerSecond(frames)).toBeLessThan(2_100);
    expect(frames.at(-1)?.rms).toBeGreaterThan(0.3);
  });

  it("resamples a 44.1 kHz context with the polyphase path, keeping the tone's pitch", async () => {
    const context = new AudioContext({ sampleRate: 44_100 }); // a device rate, not 16 kHz
    const source = await startCaptureGraph({
      stream: toneStream(1_000),
      audioContext: context,
      workletUrl: WORKLET_URL,
    });
    cleanups.push(() => source.close());
    expect(source.sampleRate).toBe(44_100);
    const frames = await collectFrames(source, 1_000);
    expect(zeroCrossingsPerSecond(frames)).toBeGreaterThan(1_900);
    expect(zeroCrossingsPerSecond(frames)).toBeLessThan(2_100);
  });

  it("answers a flush with the partial frame at once", async () => {
    const source = await startCaptureGraph({ stream: toneStream(440), workletUrl: WORKLET_URL });
    cleanups.push(() => source.close());
    await sleep(200);
    const flushed = new Promise<CaptureFrame>((resolve) => {
      const stop = source.onFrame((frame) => {
        if (frame.flush) {
          stop();
          resolve(frame);
        }
      });
    });
    source.flush();
    const frame = await flushed;
    expect(frame.pcm.length).toBeLessThan(512);
  });
});

describe("the microphone in Chromium", () => {
  it("opens one mono stream from the fake device and stops it on close", async () => {
    const mic = await openMicrophone();
    const [track] = mic.stream.getAudioTracks();
    expect(track?.readyState).toBe("live");
    expect(MIC_CONSTRAINTS.audio.echoCancellation).toBe(true);
    mic.close();
    expect(track?.readyState).toBe("ended");
  });
});

describe("the Debrief engine in Chromium", () => {
  it("runs end to end against the fake adapter: press, speak, release, final, turn_end", async () => {
    const mic = await openMicrophone();
    cleanups.push(() => mic.close());
    const fake = createFakeSttAdapter({
      script: { turns: [{ text: "Acme renewed for two years", startMs: 0, endMs: 1_200 }] },
    });
    const engine = createDebriefEngine({
      adapter: fake,
      getCredential: async () => fakeCredential(),
      workletUrl: WORKLET_URL,
    });
    cleanups.push(() => engine.stop());
    const events: VoiceEvent[] = [];
    engine.on((event) => events.push(event));
    await engine.start({
      stream: mic.stream,
      keyterms: ["Acme"],
      signal: new AbortController().signal,
      audioContext: createAudioContext(),
    });
    engine.pushToTalk(true);
    await sleep(1_600);
    engine.pushToTalk(false);
    const deadline = Date.now() + 3_000;
    while (!events.some((event) => event.type === "turn_end") && Date.now() < deadline)
      await sleep(20);

    const finals = events.filter((event) => event.type === "final");
    const ends = events.filter((event) => event.type === "turn_end");
    expect(finals.map((event) => event.type === "final" && event.utterance.text)).toEqual([
      "Acme renewed for two years",
    ]);
    expect(ends).toEqual([
      { type: "turn_end", turnId: expect.any(String), trigger: "ptt_release" },
    ]);
    expect(events.filter((event) => event.type === "level").length).toBeGreaterThan(20);
    // About 1.6 s of 16 kHz PCM16 reached the provider: the worklet's clock, not a guess.
    const seconds = fake.stats().samplesReceived / 16_000;
    expect(seconds).toBeGreaterThan(1.3);
    expect(seconds).toBeLessThan(2);
    await engine.stop();
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(engine.state).toBe("stopped");
  });
});

describe("hands-free's VAD in Chromium", () => {
  it("loads Silero v6 from local files and runs onnxruntime single-threaded, without cross-origin isolation", async () => {
    expect(globalThis.crossOriginIsolated).toBe(false);
    const context = createAudioContext();
    cleanups.push(() => context.close());
    const probabilities: number[] = [];
    const vad = await loadHandsFreeVad({
      stream: toneStream(440),
      audioContext: context,
      assetPath: dirOf(vadModelUrl),
      wasmPath: dirOf(ortWasmUrl),
      onSpeechStart: () => {},
      onSpeechEnd: () => {},
      onFrameProcessed: (probability) => probabilities.push(probability),
    });
    cleanups.push(() => vad.destroy());
    await vad.start();
    await sleep(1_000);
    // 32 ms frames: about 30 in a second, each with a speech probability.
    expect(probabilities.length).toBeGreaterThan(15);
    expect(probabilities.every((probability) => probability >= 0 && probability <= 1)).toBe(true);
  });
});
