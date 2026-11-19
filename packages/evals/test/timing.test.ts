import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DebriefTiming,
  isStubRender,
  RENDER_SAMPLE_RATE,
  RENDER_TAIL_MS,
  RenderManifest,
  STUB_RENDER_MODEL,
} from "../src";

// Written by lab/scripts/render_debriefs.py with a stand-in voice; pytest fails if the renderer
// stops writing them byte for byte (tests/test_render_debriefs.py).
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

describe("the renderer's files", () => {
  const timing = DebriefTiming.parse(read("timing.sample.json"));
  const manifest = RenderManifest.parse(read("manifest.sample.json"));

  it("parse with the schemas the e2e test will read them with", () => {
    expect(timing.sampleRate).toBe(RENDER_SAMPLE_RATE);
    expect(timing.tailMs).toBe(RENDER_TAIL_MS);
    const entry = manifest.scripts.d000;
    expect(entry).toEqual({
      hash: timing.hash,
      wav: `${timing.hash}.wav`,
      timing: `${timing.hash}.timing.json`,
      durationMs: timing.durationMs,
    });
  });

  it("place the turns in order, inside the WAV, with the tail after the last", () => {
    let previousEnd = 0;
    for (const turn of timing.turns) {
      expect(turn.startMs).toBeGreaterThanOrEqual(previousEnd);
      expect(turn.endMs).toBeGreaterThan(turn.startMs);
      expect(turn.words.map((word) => word.w)).toEqual(turn.text.split(/\s+/));
      expect(turn.words[0]?.startMs).toBe(turn.startMs);
      for (const word of turn.words) expect(word.endMs).toBeLessThanOrEqual(turn.endMs);
      previousEnd = turn.endMs;
    }
    expect(timing.durationMs).toBe(previousEnd + timing.tailMs);
  });

  it("refuse a file that isn't the renderer's format", () => {
    expect(DebriefTiming.safeParse({ ...timing, sampleRate: 44_100 }).success).toBe(false);
    expect(DebriefTiming.safeParse({ ...timing, tailMs: 100 }).success).toBe(false);
    expect(RenderManifest.safeParse({ ...manifest, version: 2 }).success).toBe(false);
  });
});

describe("--stub renders", () => {
  it("are told apart by the pseudo model file the renderer names, in both languages", () => {
    const renderer = readFileSync(
      new URL("../../../lab/scripts/render_debriefs.py", import.meta.url),
      "utf8",
    );
    expect(renderer).toContain(`STUB_MODEL_NAME = "${STUB_RENDER_MODEL}"`);
    const manifest = RenderManifest.parse(read("manifest.sample.json"));
    expect(isStubRender(manifest)).toBe(false);
    expect(isStubRender({ ...manifest, model: { [STUB_RENDER_MODEL]: "0".repeat(64) } })).toBe(
      true,
    );
  });
});
