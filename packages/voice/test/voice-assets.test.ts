// The asset step: VAD and onnxruntime files copied from node_modules (never downloaded), the ORT
// pin checked against what vad-web resolves, and the capture worklet built and working.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ORT_FILES, VAD_FILES, WORKLET_FILE, writeVoiceAssets } from "../scripts/voice-assets";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function installedDist(name: string, from: string): string {
  let dir = path.dirname(createRequire(from).resolve(name));
  const nameAt = (at: string) => {
    try {
      return JSON.parse(readFileSync(path.join(at, "package.json"), "utf8")).name as string;
    } catch {
      return undefined;
    }
  };
  while (nameAt(dir) !== name) dir = path.dirname(dir);
  return path.join(dir, "dist");
}

let publicDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  publicDir = mkdtempSync(path.join(tmpdir(), "earshot-voice-assets-"));
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in the asset step")));
  vi.stubGlobal("fetch", fetchSpy);
  await writeVoiceAssets(publicDir);
  vi.unstubAllGlobals();
}, 60_000);

afterAll(() => rmSync(publicDir, { recursive: true, force: true }));

describe("earshot-voice-assets", () => {
  it("copies the VAD and onnxruntime files byte for byte from node_modules, fetching nothing", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    const vadDist = installedDist("@ricky0123/vad-web", path.join(root, "package.json"));
    const ortDist = installedDist(
      "onnxruntime-web",
      path.join(path.dirname(vadDist), "package.json"),
    );
    for (const file of VAD_FILES) {
      expect(sha256(path.join(publicDir, "vad", file))).toBe(sha256(path.join(vadDist, file)));
    }
    for (const file of ORT_FILES) {
      expect(sha256(path.join(publicDir, "vad", file))).toBe(sha256(path.join(ortDist, file)));
    }
  });

  it("serves Silero v6 and ORT 1.31.1's single wasm build: about 17 MB raw, each under 25 MiB", () => {
    const size = (file: string) => readFileSync(path.join(publicDir, "vad", file)).byteLength;
    // Sizes from the research note (capture_llm_eval.md §1), checked against the install.
    expect(size("silero_vad_v6.onnx")).toBe(2_327_524);
    expect(size("ort-wasm-simd-threaded.wasm")).toBe(14_848_852);
    expect(size("ort-wasm-simd-threaded.mjs")).toBe(24_738);
    for (const file of [...VAD_FILES, ...ORT_FILES])
      expect(size(file)).toBeLessThan(25 * 1024 * 1024);
  });

  it("refuses to copy when vad-web resolves a different onnxruntime-web than the pin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "earshot-voice-assets-pin-"));
    try {
      await expect(writeVoiceAssets(dir, { pinnedOrtVersion: "1.22.0" })).rejects.toThrow(
        "vad-web resolves onnxruntime-web 1.31.1, but 1.22.0 is pinned",
      );
      await expect(writeVoiceAssets(dir, { pinnedOrtVersion: "^1.31.0" })).rejects.toThrow(
        "exact version",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a self-contained worklet that turns 48 kHz quanta into 512-sample PCM16 frames", () => {
    const code = readFileSync(path.join(publicDir, "voice", WORKLET_FILE), "utf8");
    expect(code).not.toMatch(/\bimport\b|\bexport\b/);
    const posted: { type: string; pcm: ArrayBuffer; rms: number; flush: boolean }[] = [];
    let registered: { name: string; processor: new () => WorkletUnderTest } | undefined;
    class AudioWorkletProcessor {
      readonly port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (message: (typeof posted)[number]) => posted.push(message),
      };
    }
    vm.runInNewContext(code, {
      sampleRate: 48_000,
      AudioWorkletProcessor,
      registerProcessor: (name: string, processor: new () => WorkletUnderTest) => {
        registered = { name, processor };
      },
    });
    expect(registered?.name).toBe("pcm16-capture");
    const Processor = registered?.processor;
    if (!Processor) throw new Error("nothing registered");
    const processor = new Processor();
    for (let quantum = 0; quantum < 375; quantum++) {
      const block = new Float32Array(128);
      for (let i = 0; i < 128; i++)
        block[i] = 0.5 * Math.sin((2 * Math.PI * 1_000 * (quantum * 128 + i)) / 48_000);
      expect(processor.process([[block]])).toBe(true);
    }
    // One second at 48 kHz is 16,000 samples at 16 kHz: 31 whole frames and 128 left over.
    expect(posted).toHaveLength(31);
    for (const message of posted) {
      expect(new Int16Array(message.pcm)).toHaveLength(512);
      expect(message.flush).toBe(false);
    }
    expect(posted.at(-1)?.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
    processor.port.onmessage?.({ data: { type: "flush" } });
    expect(posted).toHaveLength(32);
    expect(new Int16Array(posted[31]?.pcm ?? new ArrayBuffer(0))).toHaveLength(128);
    expect(posted[31]?.flush).toBe(true);
    processor.port.onmessage?.({ data: { type: "stop" } });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
  });

  it("runs as a CLI under Node 26, which runs the TypeScript directly", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "earshot-voice-assets-cli-"));
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/voice-assets.ts"), dir],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("earshot-voice-assets: 5 files");
      const missing = spawnSync(process.execPath, [path.join(root, "scripts/voice-assets.ts")], {
        encoding: "utf8",
      });
      expect(missing.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

interface WorkletUnderTest {
  readonly port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][]): boolean;
}
