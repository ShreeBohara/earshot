// `@earshot/voice/machines` and `@earshot/voice/prices` must typecheck without the DOM library,
// because the edge Worker imports them (spec §3). This compiles both entries the way the edge
// Worker's preset does (@earshot/tsconfig/worker.json: ES2023, no ambient types) and fails on any
// diagnostic. A control program proves the setup would catch a DOM reference.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = [path.join(root, "src/machines/index.ts"), path.join(root, "src/prices.ts")];

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

describe("the no-DOM entries", () => {
  it("typecheck with ES2023 alone, as the edge Worker compiles them", () => {
    const { diagnostics, sources } = compile(ENTRIES);
    expect(diagnostics).toEqual([]);
    expect(sources.some((file) => /lib\.dom(\.|$)/.test(path.basename(file)))).toBe(false);
    // Only plain modules come along: nothing that reaches for the browser.
    const own = sources.filter((file) => file.startsWith(path.join(root, "src")));
    expect(own.map((file) => path.relative(root, file)).sort()).toEqual([
      "src/codes.ts",
      "src/machines/backoff.ts",
      "src/machines/index.ts",
      "src/machines/speech-socket.ts",
      "src/prices.ts",
    ]);
  });

  it("would fail on a DOM type or global (the check's control)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "earshot-no-dom-"));
    try {
      const file = path.join(dir, "uses-dom.ts");
      writeFileSync(
        file,
        "export const stream: MediaStream | undefined = undefined;\nexport const title = () => document.title;\n",
      );
      const { diagnostics } = compile([file]);
      expect(diagnostics.join("\n")).toMatch(/MediaStream/);
      expect(diagnostics.join("\n")).toMatch(/document/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
