// The evidence clip player (Phase 5 spec §4.7, WP9) on a fake AudioContext: one 16 kHz AudioBuffer
// holding the whole clip, the span started at its padded offset for its padded duration, the
// context made and resumed by `unlock`, one span at a time, and `playing` until the span ends.
// test/browser/evidence.browser.test.ts plays through a real AudioContext in Chromium.
import { describe, expect, it } from "vitest";
import { type ClipAudioContext, ClipPlayer } from "../src/evidence";

interface Started {
  readonly when: number;
  readonly offset: number;
  readonly duration: number;
}

function fakeContext(state: AudioContextState = "suspended") {
  const buffers: { channels: number; length: number; rate: number; data: Float32Array }[] = [];
  const sources: {
    started: Started[];
    stopped: number;
    connected: boolean;
    end: () => void;
    node: AudioBufferSourceNode;
  }[] = [];
  let resumed = 0;
  const context = {
    state,
    destination: {} as AudioDestinationNode,
    resume: async () => {
      resumed += 1;
      context.state = "running";
    },
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      buffers.push({ channels, length, rate, data });
      return { getChannelData: () => data } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const record = {
        started: [] as Started[],
        stopped: 0,
        connected: false,
        end: () => {},
        node: undefined as unknown as AudioBufferSourceNode,
      };
      const node = {
        buffer: null,
        onended: null as (() => void) | null,
        connect: () => {
          record.connected = true;
        },
        disconnect: () => {
          record.connected = false;
        },
        start: (when: number, offset: number, duration: number) => {
          record.started.push({ when, offset, duration });
        },
        stop: () => {
          record.stopped += 1;
        },
      };
      record.node = node as unknown as AudioBufferSourceNode;
      record.end = () => node.onended?.();
      sources.push(record);
      return record.node;
    },
  };
  return {
    context: context as unknown as ClipAudioContext & { state: AudioContextState },
    buffers,
    sources,
    resumed: () => resumed,
  };
}

/** A clip 2 s into the session, 3 s long. */
const CLIP = { startMs: 2_000, pcm: new Int16Array(48_000).fill(16_384) };

describe("ClipPlayer", () => {
  it("unlock makes the context in the gesture and resumes it", () => {
    const fake = fakeContext("suspended");
    let made = 0;
    const player = new ClipPlayer({
      createContext: () => {
        made += 1;
        return fake.context;
      },
    });
    expect(made).toBe(0);
    player.unlock();
    player.unlock();
    expect(made).toBe(1);
    expect(fake.resumed()).toBe(1);
  });

  it("plays the padded span from one 16 kHz buffer holding the whole clip", () => {
    const fake = fakeContext("running");
    const player = new ClipPlayer({ createContext: () => fake.context });
    const changes: (string | null)[] = [];
    player.subscribe(() => changes.push(player.playing));
    player.unlock();
    const span = player.play("p1:title", CLIP, [3_000, 4_000]);

    expect(fake.buffers).toEqual([
      expect.objectContaining({ channels: 1, length: 48_000, rate: 16_000 }),
    ]);
    expect(fake.buffers[0]?.data[0]).toBe(0.5);
    expect(fake.sources[0]?.connected).toBe(true);
    // 3,000 − 250 − 2,000 = 750 ms in; 1,000 + 500 ms long.
    expect(fake.sources[0]?.started).toEqual([{ when: 0, offset: 0.75, duration: 1.5 }]);
    expect(span).toMatchObject({ start: 12_000, end: 36_000 });
    expect(player.playing).toBe("p1:title");

    fake.sources[0]?.end();
    expect(player.playing).toBeNull();
    expect(changes).toEqual(["p1:title", null]);
  });

  it("clamps the padding to the clip at both of its edges", () => {
    const fake = fakeContext("running");
    const player = new ClipPlayer({ createContext: () => fake.context });
    player.play("start", CLIP, [2_000, 2_100]);
    expect(fake.sources[0]?.started[0]).toEqual({ when: 0, offset: 0, duration: 0.35 });
    player.play("end", CLIP, [4_900, 5_000]);
    expect(fake.sources[1]?.started[0]?.offset).toBeCloseTo(2.65, 10);
    expect(fake.sources[1]?.started[0]?.duration).toBeCloseTo(0.35, 10);
  });

  it("stops the span playing when another starts, and its late end changes nothing", () => {
    const fake = fakeContext("running");
    const player = new ClipPlayer({ createContext: () => fake.context });
    player.play("a", CLIP, [3_000, 3_500]);
    player.play("b", CLIP, [4_000, 4_500]);
    expect(fake.sources[0]?.stopped).toBe(1);
    expect(fake.sources[0]?.connected).toBe(false);
    expect(player.playing).toBe("b");
    fake.sources[0]?.end();
    expect(player.playing).toBe("b");
    player.stop();
    expect(player.playing).toBeNull();
    expect(fake.sources[1]?.stopped).toBe(1);
  });

  it("plays nothing outside the clip, or without Web Audio", () => {
    const fake = fakeContext("running");
    const player = new ClipPlayer({ createContext: () => fake.context });
    expect(player.play("x", CLIP, [10_000, 11_000])).toBeNull();
    expect(fake.sources).toHaveLength(0);
    expect(player.playing).toBeNull();

    const silent = new ClipPlayer({
      createContext: () => {
        throw new Error("no Web Audio");
      },
    });
    silent.unlock();
    expect(silent.play("y", CLIP, [3_000, 3_500])).toBeNull();
    expect(silent.playing).toBeNull();
  });
});
