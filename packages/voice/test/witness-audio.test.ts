import { describe, expect, it } from "vitest";
import { audioMsOf, encodeWav, TurnAudioRecorder, WAV_HEADER_BYTES } from "../src/witness";

const MS = 16; // samples per ms at 16 kHz

/** `ms` of samples counting up from `from`, so where each sample landed is checkable. */
function ramp(ms: number, from = 0): Int16Array {
  const out = new Int16Array(ms * MS);
  for (let i = 0; i < out.length; i++) out[i] = (from + i) % 30_000;
  return out;
}

describe("encodeWav", () => {
  it("writes the canonical 44-byte header for PCM16 mono 16 kHz, then the samples little-endian", () => {
    const pcm = new Int16Array([0, 1, -1, 32_767, -32_768]);
    const wav = encodeWav(pcm);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.length * 2);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => new TextDecoder().decode(wav.subarray(offset, offset + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(WAV_HEADER_BYTES + i * 2, true))).toEqual([
      0, 1, -1, 32_767, -32_768,
    ]);
  });

  it("sizes a 120 s turn at 3.84 MB, under Groq's 25 MB free-tier cap", () => {
    expect(encodeWav(new Int16Array(120 * 16_000)).byteLength).toBe(3_840_044);
    expect(audioMsOf(120 * 16_000)).toBe(120_000);
    expect(encodeWav(new Int16Array(0)).byteLength).toBe(44);
  });
});

describe("TurnAudioRecorder", () => {
  it("records from the press to the release plus its 200 ms tail, on the session's clock", () => {
    const recorder = new TurnAudioRecorder();
    const { recording } = recorder.open(48_000); // the speech stream's end at the press: 3 s
    expect(recorder.write(ramp(1_000, 0))).toEqual([]);
    expect(recorder.release()).toEqual([]);
    expect(recording.releasing).toBe(true);
    expect(recorder.write(ramp(100, 16_000))).toEqual([]);
    // The tail ends inside this frame: it takes only the 100 ms it still needs.
    expect(recorder.write(ramp(150, 17_600))).toEqual([recording]);
    expect(recorder.write(ramp(100, 20_000))).toEqual([]); // nothing more goes in
    const audio = recording.audio();
    expect(audio.startMs).toBe(3_000);
    expect(audio.durationMs).toBe(1_200);
    expect(audio.pcm?.length).toBe(1_200 * MS);
    expect(audio.pcm?.[0]).toBe(0);
    expect(audio.pcm?.[19_199]).toBe(19_199);
  });

  it("drops the audio of a turn past the cap at once, and keeps counting it", () => {
    const recorder = new TurnAudioRecorder({ maxMs: 1_000, tailMs: 0 });
    const { recording } = recorder.open(0);
    recorder.write(ramp(800));
    recorder.write(ramp(400));
    expect(recorder.release()).toEqual([recording]);
    expect(recording.audio()).toEqual({ startMs: 0, durationMs: 1_200, pcm: null });
  });

  it("ends a running tail where the next press starts, and every recording when capture stops", () => {
    const recorder = new TurnAudioRecorder();
    const first = recorder.open(0).recording;
    recorder.write(ramp(500));
    recorder.release();
    recorder.write(ramp(50));
    const { recording: second, completed } = recorder.open(550 * MS);
    expect(completed).toEqual([first]);
    expect(first.audio().durationMs).toBe(550);
    recorder.write(ramp(300));
    expect(recorder.finish()).toEqual([second]);
    expect(second.audio()).toMatchObject({ startMs: 550, durationMs: 300 });
  });

  it("splits a hands-free turn's recording just past its last word, handing the rest to the next turn's", () => {
    const recorder = new TurnAudioRecorder(); // a 200 ms tail
    const first = recorder.open(1_000 * MS).recording;
    recorder.write(ramp(400, 0));
    recorder.write(ramp(900, 400 * MS));
    // The turn's last word ended at 1,900 ms; the end of turn came at 2,300 ms, by when the rep
    // was 300 ms into the next sentence.
    const { recording, completed } = recorder.split(1_900 * MS);
    expect(recording).toBe(first);
    expect(completed).toEqual([]);
    expect(first.complete).toBe(true);
    expect(first.audio()).toMatchObject({ startMs: 1_000, durationMs: 1_100 });
    expect(first.audio().pcm?.length).toBe(1_100 * MS);
    expect(first.audio().pcm?.at(-1)).toBe(1_100 * MS - 1);
    const next = recorder.current;
    expect(next?.startSample).toBe(2_100 * MS);
    expect(next?.audio().durationMs).toBe(200);
    // Sample for sample, the next turn's audio goes on from where the first one's stops.
    expect(next?.audio().pcm?.[0]).toBe(1_100 * MS);
    recorder.write(ramp(500, 1_300 * MS));
    const pcm = Array.from(next?.audio().pcm ?? []);
    expect(pcm).toHaveLength(700 * MS);
    expect(pcm.every((sample, i) => sample === (1_100 * MS + i) % 30_000)).toBe(true);
  });

  it("splits where the capture stands when the tail would pass it, and never before the start", () => {
    const late = new TurnAudioRecorder();
    late.open(0);
    late.write(ramp(1_000));
    expect(late.split(900 * MS).recording?.audio().durationMs).toBe(1_000);
    expect(late.current?.startSample).toBe(1_000 * MS);
    expect(late.current?.samples).toBe(0);

    const stale = new TurnAudioRecorder();
    stale.open(5_000 * MS);
    stale.write(ramp(600));
    expect(stale.split(1_000 * MS).recording?.audio().durationMs).toBe(0);
    expect(stale.current?.startSample).toBe(5_000 * MS);
    expect(stale.current?.samples).toBe(600 * MS);
  });

  it("hands nothing on from a recording past the cap: the next starts where the capture is", () => {
    const recorder = new TurnAudioRecorder({ maxMs: 1_000 });
    recorder.open(0);
    recorder.write(ramp(1_500));
    const { recording } = recorder.split(500 * MS);
    expect(recording?.audio()).toEqual({ startMs: 0, durationMs: 700, pcm: null });
    expect(recorder.current?.startSample).toBe(1_500 * MS);
    expect(recorder.current?.samples).toBe(0);
  });

  it("cuts a hands-free turn's recording with no tail, and drops one with no turn", () => {
    const recorder = new TurnAudioRecorder();
    recorder.open(0);
    recorder.write(ramp(700));
    const cut = recorder.cut();
    expect(cut?.complete).toBe(true);
    expect(cut?.audio().durationMs).toBe(700);
    recorder.open(700 * MS);
    recorder.write(ramp(300));
    recorder.drop();
    expect(recorder.current).toBeUndefined();
    expect(recorder.finish()).toEqual([]);
  });
});
