import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTokenFiles, tokenFilePath } from "../scripts/files";
import {
  buildCss,
  buildJson,
  generateTheme,
  serializeTokenFile,
  TOKEN_FILE_NAMES,
  themeInputsOf,
  tokenFiles,
} from "../src";
import { INPUT_SET_NAMES, INPUT_SETS } from "./inputs";

describe.each(INPUT_SET_NAMES)("determinism · %s", (set) => {
  // Two independent runs from separate copies of the inputs.
  const run = () => tokenFiles(generateTheme(structuredClone(INPUT_SETS[set])));
  const [first, second] = [run(), run()];

  it("the same inputs give byte-identical CSS", () => {
    expect(buildCss(second)).toBe(buildCss(first));
  });

  it("the same inputs give byte-identical token files and JSON", () => {
    for (const name of TOKEN_FILE_NAMES) {
      expect(serializeTokenFile(second[name]), name).toBe(serializeTokenFile(first[name]));
    }
    expect(buildJson(second)).toBe(buildJson(first));
  });
});

describe("committed tokens/*.tokens.json", () => {
  const committed = readTokenFiles();
  const fresh = tokenFiles(generateTheme(themeInputsOf(committed.light)));

  it("match a fresh run of the generator with the inputs they record", () => {
    for (const name of TOKEN_FILE_NAMES) {
      expect(readFileSync(tokenFilePath(name), "utf8"), `${name}.tokens.json is stale`).toBe(
        serializeTokenFile(fresh[name]),
      );
    }
  });

  it("build the same CSS as the in-memory theme", () => {
    expect(buildCss(committed)).toBe(buildCss(fresh));
  });
});
