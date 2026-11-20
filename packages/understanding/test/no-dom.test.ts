// `@earshot/understanding` must typecheck without the DOM library, because the edge Worker imports
// it (spec §3), and without Node's types, because it runs in workerd and the browser too. This
// compiles every entry the way the edge Worker's preset does (@earshot/tsconfig/worker.json:
// ES2023, no ambient types) and fails on any diagnostic. A control program proves the setup would
// catch a DOM or Node reference.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = [
  "src/names/index.ts",
  "src/link/index.ts",
  "src/witness/index.ts",
  "src/normalize/index.ts",
  "src/faithfulness.ts",
  "src/testing/index.ts",
].map((entry) => path.join(root, entry));

function workerOptions(): ts.CompilerOptions {
  const presetPath = createRequire(import.meta.url).resolve("@earshot/tsconfig/worker.json");
  const preset = ts.readConfigFile(presetPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(preset.config, ts.sys, path.dirname(presetPath));
  return { ...parsed.options, lib: ["lib.es2023.d.ts"], types: [], noEmit: true };
}

function compile(files: readonly string[]) {
  const program = ts.createProgram(files, workerOptions());
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file ? path.relative(root, diagnostic.file.fileName) : "";
    return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
  const sources = program.getSourceFiles().map((file) => file.fileName);
  return { diagnostics, sources };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

describe("the package without the DOM", () => {
  it("typechecks with ES2023 alone, as the edge Worker compiles it", () => {
    const { diagnostics, sources } = compile(ENTRIES);
    expect(diagnostics).toEqual([]);
    expect(sources.some((file) => /lib\.dom(\.|$)/.test(path.basename(file)))).toBe(false);
    expect(sources.some((file) => file.includes("@types/node"))).toBe(false);
    // Every source file is reachable from an entry, and nothing else of ours comes along.
    const own = sources.filter((file) => file.startsWith(path.join(root, "src")));
    expect(own.map((file) => path.relative(root, file)).sort()).toEqual(
      sourceFiles(path.join(root, "src")).sort(),
    );
  });

  it("would fail on a DOM or Node global (the check's control)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "earshot-no-dom-"));
    try {
      const file = path.join(dir, "uses-globals.ts");
      writeFileSync(
        file,
        [
          "export const title = () => document.title;",
          "export const later = () => setTimeout(() => {}, 1);",
          "export const bytes = (text: string) => Buffer.from(text);",
          "export const env = () => process.env.HOME;",
          "",
        ].join("\n"),
      );
      const text = compile([file]).diagnostics.join("\n");
      expect(text).toMatch(/document/);
      expect(text).toMatch(/setTimeout/);
      expect(text).toMatch(/Buffer/);
      expect(text).toMatch(/process/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
