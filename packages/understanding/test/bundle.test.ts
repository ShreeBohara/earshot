// The edge Worker will import this package (SessionDO links in memory), so each product entry must
// bundle the way wrangler bundles a Worker: no Node built-ins, nothing from `./testing`, and
// `double-metaphone` and chrono-node's English parser carried along (none of chrono's other 15
// locales). The bundled `./names`, `./link` (with the linker's parameters inside), `./normalize`,
// `./faithfulness`, and `./tiers` then run on their own, outside Vitest's module graph. `./tiers`,
// which the web Worker and the browser import too, carries none of the rest.
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
  tiers: "src/tiers/index.ts",
  correct: "src/correct/index.ts",
  followups: "src/followups/index.ts",
};
const DOUBLE_METAPHONE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?double-metaphone\//;
const CHRONO_LOCALE =
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?chrono-node\/dist\/esm\/locales\/([^/]+)\//;

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
    const locales = new Set(inputs.flatMap((input) => CHRONO_LOCALE.exec(input)?.[1] ?? []));
    expect([...locales]).toEqual(["en"]);

    const names = result.outputFiles.find((file) => path.basename(file.path) === "names.js");
    if (!names) throw new Error("no names bundle");
    // Small enough to sit in the edge Worker unnoticed: today about 30 KB, unminified.
    expect(names.text.length).toBeLessThan(60_000);

    // The linker carries its parameters (params.v1.json) inside the bundle.
    const linker = result.outputFiles.find((file) => path.basename(file.path) === "link.js");
    if (!linker) throw new Error("no link bundle");
    expect(linker.text.length).toBeLessThan(150_000);

    // The normalizers carry chrono-node's English parser: about 104 KB of the normalize bundle's
    // 142 KB today, unminified (48 KB minified, 14 KB gzipped). The whole package would carry all
    // 16 locales, about 486 KB.
    const normalize = result.outputFiles.find(
      (file) => path.basename(file.path) === "normalize.js",
    );
    const faithfulness = result.outputFiles.find(
      (file) => path.basename(file.path) === "faithfulness.js",
    );
    if (!normalize || !faithfulness) throw new Error("no normalize or faithfulness bundle");
    expect(normalize.text.length).toBeLessThan(200_000);
    expect(faithfulness.text.length).toBeLessThan(220_000);

    // The tiers import types alone from the linker and the faithfulness check: their bundle holds
    // its own file and nothing else, about 3.4 KB unminified today.
    const tiers = result.outputFiles.find((file) => path.basename(file.path) === "tiers.js");
    const tiersMeta = Object.entries(result.metafile.outputs).find(
      ([output]) => path.basename(output) === "tiers.js",
    )?.[1];
    if (!tiers || !tiersMeta) throw new Error("no tiers bundle");
    // The metafile's paths are relative to the working directory.
    expect(Object.keys(tiersMeta.inputs).map((input) => path.resolve(input))).toEqual([
      path.join(root, ENTRIES.tiers),
    ]);
    expect(tiers.text.length).toBeLessThan(12_000);

    // Corrections (Phase 5 WP13) carry the linker, the normalizers, and the faithfulness check's
    // field table, for the web Worker and the edge Worker; the follow-up rules carry the tiers and
    // nothing else, as the tiers carry nothing else.
    const correct = result.outputFiles.find((file) => path.basename(file.path) === "correct.js");
    const followups = result.outputFiles.find(
      (file) => path.basename(file.path) === "followups.js",
    );
    const followupsMeta = Object.entries(result.metafile.outputs).find(
      ([output]) => path.basename(output) === "followups.js",
    )?.[1];
    if (!correct || !followups || !followupsMeta) throw new Error("no correct or followups bundle");
    expect(correct.text.length).toBeLessThan(450_000);
    expect(
      Object.keys(followupsMeta.inputs)
        .map((input) => path.resolve(input))
        .sort(),
    ).toEqual([path.join(root, ENTRIES.followups), path.join(root, ENTRIES.tiers)].sort());

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

      const normalizeFile = path.join(dir, "normalize.mjs");
      writeFileSync(normalizeFile, normalize.text);
      const normalizers = (await import(
        /* @vite-ignore */ pathToFileURL(normalizeFile).href
      )) as typeof import("../src/normalize");
      // 00:30 CDT on 2026-11-01, before the clocks go back: tomorrow is still Monday the 2nd.
      expect(
        normalizers.resolveDate("tomorrow", "2026-11-01T05:30:00Z", "America/Chicago"),
      ).toEqual({ readings: ["2026-11-02"], certain: true, relative: true });
      expect(
        normalizers.resolveDate("next Friday", "2026-11-17T22:20:00Z", "America/Los_Angeles"),
      ).toMatchObject({ readings: ["2026-11-20", "2026-11-27"] });
      expect(normalizers.parseAmount("fifty to sixty grand")?.readings).toEqual([50_000, 60_000]);
      expect(normalizers.isNegated("Not Pacific Crest.", [4, 17])).toBe(true);

      const faithfulnessFile = path.join(dir, "faithfulness.mjs");
      writeFileSync(faithfulnessFile, faithfulness.text);
      const { checkField } = (await import(
        /* @vite-ignore */ pathToFileURL(faithfulnessFile).href
      )) as typeof import("../src/faithfulness");
      const utterance = "Send the revised invoice by Monday.";
      expect(
        checkField(
          { field: "dueDate", kind: "date", value: "2026-12-14", utterance, span: [25, 34] },
          { turnText: utterance, callTime: "2026-12-04T19:00:00Z", timeZone: "America/New_York" },
        ),
      ).toMatchObject({
        value: "2026-12-07",
        norm: { llmValue: "2026-12-14" },
        verdict: "replaced",
      });

      const tiersFile = path.join(dir, "tiers.mjs");
      writeFileSync(tiersFile, tiers.text);
      const { tierOf } = (await import(
        /* @vite-ignore */ pathToFileURL(tiersFile).href
      )) as typeof import("../src/tiers");
      expect(
        tierOf({
          riskFlags: [{ kind: "link_uncertain", field: "target" }],
          target: { decision: "linked", basis: "context", candidates: [] },
          fields: {},
        }),
      ).toEqual({ tier: "quiet", reasons: [], nameNote: "context" });

      const correctFile = path.join(dir, "correct.mjs");
      writeFileSync(correctFile, correct.text);
      const { correctProposal } = (await import(
        /* @vite-ignore */ pathToFileURL(correctFile).href
      )) as typeof import("../src/correct");
      const evidence = {
        utteranceId: "u1",
        span: [0, 4] as [number, number],
        audioMs: [0, 400] as [number, number],
        confidence: 0.9,
      };
      const corrected = correctProposal(
        {
          proposalId: "p1",
          type: "task",
          target: {
            decision: "none",
            entityId: null,
            kind: null,
            basis: null,
            p: null,
            mention: null,
            company: null,
            candidates: [],
          },
          fields: { title: { value: "Send the deck", evidence } },
          riskFlags: [],
          linker: "linker.v1",
        },
        "dueDate",
        [{ utteranceId: "u2", text: "Make it the 14th.", confidence: 1, startMs: 900, endMs: 900 }],
        {
          index: buildLinkIndex([]),
          focusEntityId: null,
          recent: [],
          kinds: ["company", "contact", "deal"],
          callTime: "2026-12-04T19:00:00Z",
          timeZone: "America/New_York",
        },
      );
      expect(corrected).toMatchObject({ ok: true, value: "2026-12-14", words: "the 14th" });

      const followupsFile = path.join(dir, "followups.mjs");
      writeFileSync(followupsFile, followups.text);
      const { followupsFor } = (await import(
        /* @vite-ignore */ pathToFileURL(followupsFile).href
      )) as typeof import("../src/followups");
      expect(
        followupsFor([
          {
            proposalId: "p1",
            type: "task",
            riskFlags: [],
            target: { decision: "linked", basis: "exact", candidates: [] },
            fields: { title: { value: "Send the deck" } },
          },
        ]),
      ).toEqual([
        { proposalId: "p1", field: "dueDate", rule: "due_date", text: "When is it due?" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
