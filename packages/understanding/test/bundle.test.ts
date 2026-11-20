// The edge Worker will import this package (SessionDO links in memory), so each product entry must
// bundle the way wrangler bundles a Worker: no Node built-ins, nothing from `./testing`, and
// `double-metaphone` carried along. The bundled `./names` and `./link` (with the linker's
// parameters inside) then run on their own, outside Vitest's module graph.
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

    // The linker carries its parameters (params.v1.json) inside the bundle.
    const linker = result.outputFiles.find((file) => path.basename(file.path) === "link.js");
    if (!linker) throw new Error("no link bundle");
    expect(linker.text.length).toBeLessThan(150_000);

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

      const linkFile = path.join(dir, "link.mjs");
      writeFileSync(linkFile, linker.text);
      const { buildLinkIndex, link, LINKER_PARAMS_V1 } = (await import(
        /* @vite-ignore */ pathToFileURL(linkFile).href
      )) as typeof import("../src/link");
      const index = buildLinkIndex([
        { id: "co_1", kind: "company", name: "Knight Security", aliases: [] },
        { id: "co_2", kind: "company", name: "Basalt Mining", aliases: [] },
      ]);
      const result = link(
        { text: "Knight Security", kind: "company" },
        { index, focusEntityId: null, recent: [], turnMentions: [], params: LINKER_PARAMS_V1 },
      );
      expect(LINKER_PARAMS_V1.version).toBe("linker.v1");
      expect(result).toMatchObject({ decision: "linked", entityId: "co_1", basis: "exact" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
