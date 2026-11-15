import { DEFAULT_INPUTS, generateTheme, type Theme, type ThemeInputs } from "../src";

/** The default inputs plus the spec's two extremes. */
export const INPUT_SETS = {
  default: DEFAULT_INPUTS,
  "orange accent, contrast 0": {
    base: DEFAULT_INPUTS.base,
    accent: { l: 0.68, c: 0.21, h: 45 },
    contrast: 0,
  },
  "cool base, contrast 100": {
    base: { hue: 250, chroma: 0.03 },
    accent: DEFAULT_INPUTS.accent,
    contrast: 100,
  },
} as const satisfies Record<string, ThemeInputs>;

export type InputSetName = keyof typeof INPUT_SETS;
export const INPUT_SET_NAMES = Object.keys(INPUT_SETS) as InputSetName[];

const themes = new Map<InputSetName, Theme>();

/** Generated once per input set; the generator is pure, so sharing is safe. */
export function themeFor(name: InputSetName): Theme {
  let theme = themes.get(name);
  if (!theme) {
    theme = generateTheme(INPUT_SETS[name]);
    themes.set(name, theme);
  }
  return theme;
}
