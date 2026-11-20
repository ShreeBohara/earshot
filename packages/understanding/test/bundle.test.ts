// The edge Worker will import this package (SessionDO links in memory), so each product entry must
// bundle the way wrangler bundles a Worker: no Node built-ins, nothing from `./testing`, and
// `double-metaphone` carried along. The bundled `./names` then runs on its own, outside Vitest's
// module graph.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = {
  names: "src/names/index.ts",
  link: "src/link/index.ts",
  witness: "src/witness/index.ts",
  normalize: "src/normalize/index.ts",
  faithfulness: "src/faithfulness.ts",
};
const DOUBLE_METAPHONE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?double-metaphone\//;

describe("the Worker bundle", () => {
  it("bundles every product entry for workerd, without Node or the test fixtures", async () => {
    const result = await build({
      entryPoints: Object.fromEntries(
        Object.entries(ENTRIES).map(([name, entry]) => [name, path.join(root, entry)]),
      ),
      bundle: true,
      format: "esm",
      // Neutral: an import of a Node built-in fails to resolve, as it would in a Worker without
      // nodejs_compat. The conditions are the ones wrangler resolves package exports with.
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      target: "es2022",
      outdir: path.join(root, "dist-bundle-test"),
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.warnings).toEqual([]);

    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => input.includes("src/testing/"))).toEqual([]);
    expect(inputs.some((input) => DOUBLE_METAPHONE.test(input))).toBe(true);

    const names = result.outputFiles.find((file) => path.basename(file.path) === "names.js");
    if (!names) throw new Error("no names bundle");
    // Small enough to sit in the edge Worker unnoticed: today about 30 KB, unminified.
    expect(names.text.length).toBeLessThan(60_000);

    const dir = mkdtempSync(path.join(tmpdir(), "earshot-understanding-bundle-"));
    try {
      const file = path.join(dir, "names.mjs");
      writeFileSync(file, names.text);
      const bundled = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
        phoneticKeys: (names: readonly string[]) => string[];
        similarity: (a: string, b: string) => number;
      };
      expect(bundled.phoneticKeys(["Knight Security"])).toEqual(["NT", "SKRT"]);
      expect(bundled.similarity("Akme", "Acme")).toBe(0.25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
