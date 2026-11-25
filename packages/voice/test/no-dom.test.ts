// `@earshot/voice/machines` and `@earshot/voice/prices` must typecheck without the DOM library,
// because the edge Worker imports them (spec §3). This compiles both entries the way the edge
// Worker's preset does (@earshot/tsconfig/worker.json: ES2023, no ambient types) and fails on any
// diagnostic. A control program proves the setup would catch a DOM reference.
//
// The connection machine reads the close codes from `@earshot/core`, whose session tickets use
// WebCrypto and TextEncoder/TextDecoder. Workers provide both (the edge Worker's generated types
// declare them), so the check adds a minimal declaration of exactly those and nothing else: no
// DOM, no timers, no WebSocket. The control compiles with the same declaration.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = [path.join(root, "src/machines/index.ts"), path.join(root, "src/prices.ts")];

/** WebCrypto and the Encoding API, as far as `@earshot/core` uses them: what Workers provide. */
const WORKER_CRYPTO_DECLARATIONS = `
type BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer;
interface KeyAlgorithm { readonly name: string }
interface CryptoKey {
  readonly algorithm: KeyAlgorithm;
  readonly extractable: boolean;
  readonly type: string;
  readonly usages: string[];
}
interface HmacImportParams { readonly name: string; readonly hash: string | KeyAlgorithm }
interface SubtleCrypto {
  importKey(format: "raw", keyData: BufferSource, algorithm: HmacImportParams, extractable: boolean, keyUsages: readonly string[]): Promise<CryptoKey>;
  sign(algorithm: string | KeyAlgorithm, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  verify(algorithm: string | KeyAlgorithm, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
  digest(algorithm: string | KeyAlgorithm, data: BufferSource): Promise<ArrayBuffer>;
}
interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}
declare var crypto: Crypto;
interface TextEncoder { encode(input?: string): Uint8Array<ArrayBuffer> }
declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
interface TextDecoder { decode(input?: BufferSource): string }
declare var TextDecoder: {
  prototype: TextDecoder;
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};
`;

const scratch = mkdtempSync(path.join(tmpdir(), "earshot-no-dom-"));
const declarations = path.join(scratch, "worker-crypto.d.ts");
writeFileSync(declarations, WORKER_CRYPTO_DECLARATIONS);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function workerOptions(): ts.CompilerOptions {
  const presetPath = createRequire(import.meta.url).resolve("@earshot/tsconfig/worker.json");
  const preset = ts.readConfigFile(presetPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(preset.config, ts.sys, path.dirname(presetPath));
  return { ...parsed.options, lib: ["lib.es2023.d.ts"], types: [], noEmit: true };
}

function compile(files: readonly string[]) {
  const program = ts.createProgram([declarations, ...files], workerOptions());
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file ? path.relative(root, diagnostic.file.fileName) : "";
    return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
  const sources = program.getSourceFiles().map((file) => file.fileName);
  return { diagnostics, sources };
}

describe("the no-DOM entries", () => {
  it("typecheck with ES2023 and WebCrypto alone, as the edge Worker compiles them", () => {
    const { diagnostics, sources } = compile(ENTRIES);
    expect(diagnostics).toEqual([]);
    expect(sources.some((file) => /lib\.dom(\.|$)/.test(path.basename(file)))).toBe(false);
    // Only plain modules come along: nothing that reaches for the browser.
    const own = sources.filter((file) => file.startsWith(path.join(root, "src")));
    expect(own.map((file) => path.relative(root, file)).sort()).toEqual([
      "src/codes.ts",
      "src/machines/auto-mute.ts",
      "src/machines/backoff.ts",
      "src/machines/capture.ts",
      "src/machines/connection.ts",
      "src/machines/index.ts",
      "src/machines/retry.ts",
      "src/machines/silent-response.ts",
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
        [
          "export const stream: MediaStream | undefined = undefined;",
          "export const title = () => document.title;",
          "export const later = () => setTimeout(() => {}, 1);",
          "export const socket = (url: string) => new WebSocket(url);",
          "",
        ].join("\n"),
      );
      const { diagnostics } = compile([file]);
      const text = diagnostics.join("\n");
      expect(text).toMatch(/MediaStream/);
      expect(text).toMatch(/document/);
      // The WebCrypto declaration adds nothing else a machine could lean on.
      expect(text).toMatch(/setTimeout/);
      expect(text).toMatch(/WebSocket/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
