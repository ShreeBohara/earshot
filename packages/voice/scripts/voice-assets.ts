#!/usr/bin/env node
// Writes the voice runtime's static assets into a web app's public directory (spec WP4 step 7):
//
//   earshot-voice-assets <publicDir>
//
//   <publicDir>/vad/silero_vad_v6.onnx              from @ricky0123/vad-web
//   <publicDir>/vad/vad.worklet.bundle.min.js       from @ricky0123/vad-web
//   <publicDir>/vad/ort-wasm-simd-threaded.wasm     from onnxruntime-web
//   <publicDir>/vad/ort-wasm-simd-threaded.mjs      from onnxruntime-web
//   <publicDir>/voice/pcm16-capture.worklet.js      built from src/capture/worklet.ts
//
// Everything comes from the installed packages; nothing is downloaded. The onnxruntime-web files
// come from the copy vad-web itself resolves, and that copy must be the version package.json pins,
// or the JS glue a bundler links and the wasm served here could disagree. Node 26 runs this file
// as TypeScript directly.
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VAD_FILES = ["silero_vad_v6.onnx", "vad.worklet.bundle.min.js"] as const;
export const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"] as const;
export const WORKLET_FILE = "pcm16-capture.worklet.js";

export interface WrittenAsset {
  readonly path: string;
  readonly bytes: number;
}

interface PackageInfo {
  readonly dir: string;
  readonly version: string;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

/** Where `name` is installed as seen from `fromFile`, found by walking up from its entry point. */
async function findPackage(name: string, fromFile: string): Promise<PackageInfo> {
  let dir = path.dirname(createRequire(fromFile).resolve(name));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    try {
      const json = await readJson(manifest);
      if (json.name === name && typeof json.version === "string") {
        return { dir, version: json.version };
      }
    } catch {
      // no package.json at this level
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`voice-assets: can't find the ${name} package`);
    dir = parent;
  }
}

async function copyInto(from: string, toDir: string, file: string): Promise<WrittenAsset> {
  const target = path.join(toDir, file);
  await copyFile(path.join(from, file), target);
  return { path: target, bytes: (await stat(target)).size };
}

export interface VoiceAssetOptions {
  /** The onnxruntime-web version to insist on. Defaults to package.json's pin. */
  readonly pinnedOrtVersion?: string;
}

/** Writes every asset under `publicDir` and returns what it wrote. */
export async function writeVoiceAssets(
  publicDir: string,
  options: VoiceAssetOptions = {},
): Promise<WrittenAsset[]> {
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  const pinned = options.pinnedOrtVersion ?? dependencies["onnxruntime-web"];
  if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error("voice-assets: package.json must pin onnxruntime-web to an exact version");
  }

  const vad = await findPackage("@ricky0123/vad-web", path.join(packageRoot, "package.json"));
  const ort = await findPackage("onnxruntime-web", path.join(vad.dir, "package.json"));
  if (ort.version !== pinned) {
    throw new Error(
      `voice-assets: vad-web resolves onnxruntime-web ${ort.version}, but ${pinned} is pinned`,
    );
  }

  const vadDir = path.join(publicDir, "vad");
  const voiceDir = path.join(publicDir, "voice");
  await mkdir(vadDir, { recursive: true });
  await mkdir(voiceDir, { recursive: true });

  const written: WrittenAsset[] = [];
  for (const file of VAD_FILES)
    written.push(await copyInto(path.join(vad.dir, "dist"), vadDir, file));
  for (const file of ORT_FILES)
    written.push(await copyInto(path.join(ort.dir, "dist"), vadDir, file));

  const worklet = path.join(voiceDir, WORKLET_FILE);
  await build({
    entryPoints: [path.join(packageRoot, "src/capture/worklet.ts")],
    outfile: worklet,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
  written.push({ path: worklet, bytes: (await stat(worklet)).size });
  return written;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: earshot-voice-assets <publicDir>");
    process.exit(2);
  }
  const publicDir = path.resolve(target);
  const written = await writeVoiceAssets(publicDir);
  const total = written.reduce((sum, asset) => sum + asset.bytes, 0);
  for (const asset of written) {
    console.log(
      `  ${path.relative(publicDir, asset.path)}  ${(asset.bytes / 1024).toFixed(0)} KiB`,
    );
  }
  console.log(`earshot-voice-assets: ${written.length} files, ${(total / 1048576).toFixed(1)} MiB`);
}

// Run as a script (the bin shim passes a symlinked path, so compare real paths), not imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
