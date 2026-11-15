import Color from "colorjs.io";
import { describe, expect, it } from "vitest";
import { buildCss, flatten, isReference, MODES, tokenFiles } from "../src";
import { INPUT_SET_NAMES, themeFor } from "./inputs";

const COLOR_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi;

/** Splits tokens.css into its sRGB part and the bodies of its `color-gamut: p3` blocks. */
function splitCss(css: string): { srgb: string; p3: string } {
  const p3Blocks = css.match(/@media [^{]*color-gamut: p3[^{]*\{[\s\S]*?\n\}/g) ?? [];
  return {
    srgb: p3Blocks.reduce((rest, block) => rest.replace(block, ""), css),
    p3: p3Blocks.join("\n"),
  };
}

describe.each(INPUT_SET_NAMES)("gamut · %s", (set) => {
  const files = tokenFiles(themeFor(set));
  const { srgb, p3 } = splitCss(buildCss(files));

  it("every sRGB value in tokens.css is in the sRGB gamut", () => {
    const values = srgb.match(COLOR_VALUE) ?? [];
    expect(values.length).toBeGreaterThan(100);
    for (const value of values) {
      expect(value, "sRGB declarations are hex or rgb()").toMatch(/^#[0-9a-f]{6}$|^rgb\(/);
      expect(new Color(value).inGamut("srgb"), value).toBe(true);
    }
  });

  it("every P3 override is inside Display P3 and outside sRGB", () => {
    const values = p3.match(COLOR_VALUE) ?? [];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const color = new Color(value);
      expect(color.spaceId, value).toBe("p3");
      expect(color.inGamut("p3"), value).toBe(true);
      expect(color.inGamut("srgb"), `${value} needs no override`).toBe(false);
    }
  });

  it("each token's hex is the CSS Color 4 sRGB gamut mapping of its components", () => {
    for (const mode of MODES) {
      for (const { path, token } of flatten(files[mode].tokens)) {
        if (token.$type !== "color" || isReference(token.$value)) continue;
        const { components, hex } = token.$value;
        const mapped = new Color("oklch", [...components])
          .toGamut({ space: "srgb", method: "css" })
          .to("srgb");
        const bytes = mapped.coords.map((c) => Math.round(Math.min(1, Math.max(0, c ?? 0)) * 255));
        const expected = `#${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
        expect(hex, `${mode}.${path.join(".")}`).toBe(expected);
      }
    }
  });
});
