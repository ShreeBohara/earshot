import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUTS,
  generateTheme,
  LIGHTNESS,
  lightnessCurve,
  MODES,
  RAMP_NAMES,
  STATE_HUES,
  STATE_NAMES,
} from "../src";
import { worstContrast } from "../src/color";
import { INPUT_SET_NAMES, themeFor } from "./inputs";

const REACH = [0, 0, 0, 0, 0, 0.04, 0.04, 0.04, 0, 0, 0.06, 0.06];
const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("lightness curves", () => {
  it("contrast 50 leaves the tuned curves untouched", () => {
    for (const mode of MODES) expect(lightnessCurve(mode, 50)).toEqual(LIGHTNESS[mode]);
  });

  it("contrast moves steps 6–8 by up to 0.04 and 11–12 by up to 0.06, away from the background", () => {
    for (const mode of MODES) {
      const away = mode === "light" ? -1 : 1;
      const [at0, at50, at100] = [0, 50, 100].map((contrast) => lightnessCurve(mode, contrast));
      at50?.forEach((l, i) => {
        const reach = REACH[i] ?? 0;
        expect(at100?.[i], `${mode} step ${i + 1} at 100`).toBeCloseTo(
          Math.min(1, l + away * reach),
          6,
        );
        expect(at0?.[i], `${mode} step ${i + 1} at 0`).toBeCloseTo(l - away * reach, 6);
      });
    }
  });

  it("every step stays in order across the whole contrast range", () => {
    for (const mode of MODES) {
      for (let contrast = 0; contrast <= 100; contrast += 10) {
        const curve = lightnessCurve(mode, contrast);
        for (let i = 1; i < curve.length; i++) {
          const [prev, next] = [curve[i - 1] ?? 0, curve[i] ?? 0];
          expect(
            mode === "light" ? next < prev : next > prev,
            `${mode} ${contrast}: step ${i + 1}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe.each(INPUT_SET_NAMES)("ramps · %s", (set) => {
  const theme = themeFor(set);

  it("has twelve steps in every ramp, in both modes", () => {
    for (const mode of MODES) {
      for (const ramp of RAMP_NAMES)
        expect(theme[mode].ramps[ramp], `${mode} ${ramp}`).toHaveLength(12);
    }
  });

  // CSS Color 4 gamut mapping returns a clipped color within a deltaE OK of 0.02 of the
  // chroma-reduced one, so hue may turn a little where the request is far out of gamut. Measured
  // as a hue difference in OKLab (2·C·sin(Δh/2)), every step must stay inside that tolerance.
  it("keeps every state step at its fixed hue, within the gamut mapping's tolerance", () => {
    for (const mode of MODES) {
      for (const state of STATE_NAMES) {
        theme[mode].ramps[state].forEach(({ oklch: [, chroma, hue] }, i) => {
          const angle = (hueGap(hue, STATE_HUES[state]) * Math.PI) / 180;
          expect(2 * chroma * Math.sin(angle / 2), `${mode} ${state} step ${i + 1}`).toBeLessThan(
            0.02,
          );
        });
      }
    }
  });
});

describe("accent", () => {
  it("is ink on paper in light and paper on ink in dark, by default", () => {
    const { light, dark } = generateTheme();
    expect(light.semantic.accent.oklch[0]).toBeCloseTo(0.3, 2);
    expect(light.semantic["on-accent"]).toMatchObject({ ramp: "neutral", step: 1 });
    expect(dark.semantic.accent.oklch[0]).toBeGreaterThan(0.9);
    expect(dark.semantic["on-accent"]).toMatchObject({ ramp: "neutral", step: 1 });
  });

  it("nudges a mid-lightness accent until its text reaches 4.5:1, hover included", () => {
    for (const l of [0.55, 0.58, 0.6, 0.62, 0.65]) {
      const theme = generateTheme({ ...DEFAULT_INPUTS, accent: { l, c: 0.15, h: 150 } });
      for (const mode of MODES) {
        const { accent, "accent-hover": hover, "on-accent": text } = theme[mode].semantic;
        expect(worstContrast(text, accent), `${mode} L ${l}`).toBeGreaterThanOrEqual(4.5);
        expect(worstContrast(text, hover), `${mode} L ${l} hover`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("step 8 guard", () => {
  it("keeps border-strong and focus-ring at 3:1 beyond the tuned inputs", () => {
    // Without the guard, this green focus ring sat at 2.90:1 on the tinted light background.
    const theme = generateTheme({
      base: { hue: 0, chroma: 0.06 },
      accent: { l: 0.6, c: 0.15, h: 150 },
      contrast: 0,
    });
    for (const mode of MODES) {
      const { bg, "border-strong": border, "focus-ring": ring } = theme[mode].semantic;
      expect(worstContrast(border, bg), `${mode} border-strong`).toBeGreaterThanOrEqual(3);
      expect(worstContrast(ring, bg), `${mode} focus-ring`).toBeGreaterThanOrEqual(3);
    }
  });

  it("leaves the tuned curve alone for the tested inputs", () => {
    for (const set of INPUT_SET_NAMES) {
      const theme = themeFor(set);
      for (const mode of MODES) {
        const expected = lightnessCurve(mode, theme.inputs.contrast)[7] ?? 0;
        for (const ramp of ["neutral", "accent"] as const) {
          const [l] = theme[mode].ramps[ramp][7]?.oklch ?? [];
          expect(l, `${set} ${mode} ${ramp}`).toBeCloseTo(expected, 2);
        }
      }
    }
  });
});

describe("inputs", () => {
  it("rejects values outside their ranges", () => {
    const bad = [
      { ...DEFAULT_INPUTS, contrast: 101 },
      { ...DEFAULT_INPUTS, accent: { l: 1.2, c: 0.1, h: 0 } },
      { ...DEFAULT_INPUTS, base: { hue: Number.NaN, chroma: 0.01 } },
      { ...DEFAULT_INPUTS, base: { hue: 85, chroma: -0.01 } },
    ];
    for (const inputs of bad) expect(() => generateTheme(inputs)).toThrow(RangeError);
  });

  it("normalizes hues", () => {
    const theme = generateTheme({ ...DEFAULT_INPUTS, base: { hue: 445, chroma: 0.01 } });
    expect(theme.inputs.base.hue).toBe(85);
  });
});
