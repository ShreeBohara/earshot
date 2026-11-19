// The VAD and onnxruntime-web load only when hands-free is chosen, so neither may be in the main
// bundle (spec WP4 tests). This bundles the browser entry the way an app would, with code
// splitting, and checks they land in a lazy chunk of their own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

/** Escapes every character with a meaning in a regular expression, backslash included. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const LAZY =
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@ricky0123\/vad-web|onnxruntime-web|onnxruntime-common)\//;

describe("the browser bundle", () => {
  it("keeps vad-web and onnxruntime-web out of the entry chunk, in a lazy one", async () => {
    const result = await build({
      entryPoints: { index: path.join(root, "src/index.ts") },
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outdir: path.join(root, "dist-bundle-test"),
      write: false,
      metafile: true,
      logLevel: "silent",
      // onnxruntime-web's Node-only paths reference these; a browser bundler stubs them out.
      external: ["fs", "path", "url", "worker_threads", "module", "node:*"],
    });
    const outputs = Object.entries(result.metafile.outputs as Metafile["outputs"]);
    const entry = outputs.find(([, output]) => output.entryPoint?.endsWith("src/index.ts"));
    if (!entry) throw new Error("no entry chunk");
    const [entryName, entryOutput] = entry;
    const entryInputs = Object.keys(entryOutput.inputs);
    expect(entryInputs.filter((input) => LAZY.test(input))).toEqual([]);
    // The DSP, adapters, and engine are in the entry; the fakes aren't anywhere.
    expect(
      entryInputs.some((input) => input.endsWith("src/engines/debrief/debrief-engine.ts")),
    ).toBe(true);
    expect(
      outputs
        .flatMap(([, output]) => Object.keys(output.inputs))
        .some((input) => input.includes("src/testing/")),
    ).toBe(false);

    const lazy = outputs.filter(
      ([name, output]) =>
        name !== entryName && Object.keys(output.inputs).some((input) => LAZY.test(input)),
    );
    expect(lazy.length).toBeGreaterThan(0);
    // The entry reaches the lazy chunk only through a dynamic import.
    const entryText = result.outputFiles.find((file) => file.path.endsWith(entryName))?.text ?? "";
    const lazyFile = path.basename(lazy[0]?.[0] ?? "");
    expect(entryText).toMatch(new RegExp(`import\\(\\s*"\\./${escapeRegExp(lazyFile)}"\\s*\\)`));
    expect(entryText).not.toMatch(new RegExp(`from\\s*"\\./${escapeRegExp(lazyFile)}"`));
  }, 60_000);
});
