import { describe, expect, it } from "vitest";
import {
  buildCss,
  buildJson,
  isReference,
  MODES,
  SHADCN_NAMES,
  tokenFiles,
  typographyTokens,
} from "../src";
import { themeFor } from "./inputs";

const theme = themeFor("default");
const css = buildCss(tokenFiles(theme));

/** The body of the first rule with this exact selector line, wherever it's nested. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {\n`);
  if (start === -1) throw new Error(`no block for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

describe("tokens.css", () => {
  it("puts light on :root, dark on [data-theme=dark], and defaults to dark with prefers-color-scheme", () => {
    expect(css).toContain(':root,\n[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain('\n[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    color-scheme: dark;',
    );
  });

  it("adds P3 overrides under @media (color-gamut: p3)", () => {
    expect(css).toMatch(
      /@media \(color-gamut: p3\) \{\n {2}:root,\n {2}\[data-theme="light"\] \{\n {4}--es-/,
    );
    expect(css).toContain("color(display-p3 ");
  });

  it("declares every shadcn alias in the light, dark, and prefers-color-scheme blocks", () => {
    const blocks = [
      '[data-theme="light"]',
      '[data-theme="dark"]',
      '  :root:not([data-theme="light"])',
    ];
    for (const selector of blocks) {
      for (const name of SHADCN_NAMES)
        expect(block(selector), selector).toMatch(`--${name}: var(--es-`);
    }
  });

  it("maps shadcn's --accent to neutral step 4 and --primary to Earshot's accent", () => {
    for (const mode of MODES) {
      expect(theme[mode].shadcn.accent).toEqual({ ramp: "neutral", step: 4 });
      expect(theme[mode].shadcn.primary).toEqual({ semantic: "accent" });
    }
    expect(css).toContain("  --accent: var(--es-neutral-4);");
    expect(css).toContain("  --primary: var(--es-accent);");
  });

  it("caps durations under prefers-reduced-motion", () => {
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --es-duration-medium: var(--es-duration-reduced);",
    );
  });
});

describe("hand-written tokens", () => {
  it("sets display sizes in Instrument Serif with negative tracking, the rest in Geist", () => {
    for (const [size, { $value }] of Object.entries(typographyTokens.type)) {
      if (isReference($value)) throw new Error(`type.${size} should be a composite, not an alias`);
      const display = Number(size) >= 30;
      expect($value.fontFamily, size).toBe(display ? "{font.serif}" : "{font.sans}");
      if (display) expect($value.letterSpacing, size).toBe(`{font.tracking.${size}}`);
    }
    expect(css).toContain('--es-font-serif: "Instrument Serif"');
    expect(css).toContain("--es-font-tracking-60: -1.2px;");
  });

  it("keeps tokens.json a single DTCG document with references that resolve", () => {
    const json = JSON.parse(buildJson(tokenFiles(theme))) as Record<string, unknown>;
    const references = JSON.stringify(json).match(/"\{[^"}]+\}"/g) ?? [];
    expect(references.length).toBeGreaterThan(50);
    for (const reference of references) {
      const path = reference.slice(2, -2).split(".");
      const target = path.reduce<unknown>(
        (node, key) => (node as Record<string, unknown> | undefined)?.[key],
        json,
      );
      expect(target, reference).toHaveProperty("$value");
    }
  });
});
