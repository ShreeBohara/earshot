// The theme generator: three inputs in, two complete themes out.
import { normalizeHue, type Swatch, swatch, worstContrast } from "./color";

export interface ThemeInputs {
  /** Hue (degrees) and peak chroma of the neutral ramp. */
  readonly base: { readonly hue: number; readonly chroma: number };
  /** The brand color, in OKLCH. */
  readonly accent: { readonly l: number; readonly c: number; readonly h: number };
  /** 0–100: how far text and borders sit from their backgrounds. 50 leaves the curves as tuned. */
  readonly contrast: number;
}

/** Warm paper neutrals and a blue-black ink accent, so color is left for the four states. */
export const DEFAULT_INPUTS: ThemeInputs = {
  base: { hue: 85, chroma: 0.01 },
  accent: { l: 0.3, c: 0.03, h: 265 },
  contrast: 50,
};

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

export const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type Step = (typeof STEPS)[number];

export const STATE_NAMES = ["proposed", "conflict", "synced", "failed"] as const;
export type StateName = (typeof STATE_NAMES)[number];

/** Each state's ramp sits at a fixed hue, whatever the inputs. */
export const STATE_HUES: Readonly<Record<StateName, number>> = {
  proposed: 250,
  conflict: 75,
  synced: 150,
  failed: 25,
};

export const RAMP_NAMES = ["neutral", "accent", ...STATE_NAMES] as const;
export type RampName = (typeof RAMP_NAMES)[number];

/** Twelve swatches; index 0 is step 1. */
export type Ramp = readonly Swatch[];

/**
 * Lightness of each step (index 0 is step 1) before the `contrast` adjustment. Every ramp in
 * a mode uses this curve; the accent then pins its solids (steps 9–10) to the accent input,
 * and for inputs beyond the tuned ones a guard can move step 8 further from the background.
 *
 * Step jobs: 1–2 backgrounds · 3–5 component fills (rest, hover, pressed) · 6–8 borders
 * (subtle, default, strong or focus) · 9–10 solid fills · 11–12 text (muted, default).
 *
 * Spec starting values:
 *   light 0.985 0.970 0.945 0.920 0.895 0.860 0.810 0.740 0.560 0.520 0.440 0.230
 *   dark  0.150 0.180 0.215 0.245 0.275 0.315 0.370 0.450 0.560 0.600 0.800 0.950
 *
 * Final values, tuned against test/contrast.test.ts (default inputs, saturated orange accent
 * at contrast 0, cool base at contrast 100):
 *   light 0.985 0.970 0.945 0.920 0.895 0.845 0.720 0.600 0.540 0.500 0.420 0.230
 *   dark  0.150 0.180 0.215 0.245 0.275 0.325 0.440 0.555 0.620 0.660 0.800 0.950
 *
 * - Step 8 (border-strong, focus-ring) moved 0.14 darker in light and 0.105 lighter in dark:
 *   the spec values gave 2.2:1 and 2.6:1 on `bg`. The worst cases, both with the orange
 *   accent at contrast 0, are now 3.21:1 (light border-strong) and 3.24:1 (dark focus ring,
 *   on a P3 screen).
 * - Step 7 sits halfway between steps 6 and 8.
 * - Steps 6, 9, 10 and 11 moved just enough to keep every ramp in order at both contrast
 *   extremes: 6 stays past 5 at contrast 0, 8 stays short of 9 at contrast 100, and 11 stays
 *   past 10 at contrast 0. Dark solids at 0.62 read better with dark text than with white.
 */
export const LIGHTNESS: Readonly<Record<Mode, readonly number[]>> = {
  light: [0.985, 0.97, 0.945, 0.92, 0.895, 0.845, 0.72, 0.6, 0.54, 0.5, 0.42, 0.23],
  dark: [0.15, 0.18, 0.215, 0.245, 0.275, 0.325, 0.44, 0.555, 0.62, 0.66, 0.8, 0.95],
};

/** How far `contrast` moves each step away from (100) or toward (0) the background. */
const CONTRAST_REACH = [0, 0, 0, 0, 0, 0.04, 0.04, 0.04, 0, 0, 0.06, 0.06] as const;

/** Neutral chroma as a share of `base.chroma`: peaks mid-ramp, eases off toward paper and ink. */
const NEUTRAL_CHROMA = [0.7, 0.76, 0.82, 0.88, 0.94, 1, 1, 0.94, 0.88, 0.82, 0.76, 0.7] as const;

/** Accent and state chroma as a share of their own chroma: full on the solids, tapered at both ends. */
const COLOR_CHROMA = [0.1, 0.18, 0.3, 0.4, 0.5, 0.6, 0.72, 0.86, 1, 1, 0.9, 0.5] as const;

/** Peak chroma of the state ramps before gamut mapping. sRGB trims it per hue; P3 keeps more. */
export const STATE_CHROMA = 0.16;

/**
 * A dark accent can't be a button on a dark background, so in the dark theme the accent's
 * lightness becomes max(L, 1.25 − L): ink at 0.30 turns into paper at 0.95, while accents
 * from 0.625 up keep their lightness. The mapping is continuous, so a slider never jumps.
 */
const ACCENT_MIRROR = 1.25;

const TEXT_CONTRAST = 4.5;
const NON_TEXT_CONTRAST = 3;
const SOLVE_STEP = 0.005;

export const STATE_ROLES = ["bg", "border", "text", "solid"] as const;
export type StateRole = (typeof STATE_ROLES)[number];
const STATE_ROLE_STEPS: Readonly<Record<StateRole, Step>> = {
  bg: 3,
  border: 7,
  text: 11,
  solid: 9,
};

export const SEMANTIC_NAMES = [
  "bg",
  "bg-subtle",
  "surface",
  "surface-raised",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "accent",
  "accent-hover",
  "on-accent",
  "focus-ring",
  ...STATE_NAMES.flatMap((state) => STATE_ROLES.map((role) => `state-${state}-${role}` as const)),
] as const;
export type SemanticName = (typeof SEMANTIC_NAMES)[number];

export interface RampRef {
  readonly ramp: RampName;
  readonly step: Step;
}

/** A semantic token: the ramp step it points at, plus that step's color. */
export interface SemanticColor extends RampRef, Swatch {}

/** shadcn/ui variables point at a semantic token or, for a few fills, straight at a ramp step. */
export type AliasTarget = { readonly semantic: SemanticName } | RampRef;

export const SHADCN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
] as const;
export type ShadcnName = (typeof SHADCN_NAMES)[number];

const SHADCN: Readonly<Record<ShadcnName, AliasTarget>> = {
  background: { semantic: "bg" },
  foreground: { semantic: "text" },
  card: { semantic: "surface" },
  "card-foreground": { semantic: "text" },
  popover: { semantic: "surface-raised" },
  "popover-foreground": { semantic: "text" },
  primary: { semantic: "accent" },
  "primary-foreground": { semantic: "on-accent" },
  secondary: { ramp: "neutral", step: 3 },
  "secondary-foreground": { semantic: "text" },
  muted: { ramp: "neutral", step: 3 },
  "muted-foreground": { semantic: "text-muted" },
  // In shadcn, --accent is the subtle hover fill of menus and ghost buttons, not a brand color.
  accent: { ramp: "neutral", step: 4 },
  "accent-foreground": { semantic: "text" },
  // shadcn uses --destructive as text (on the page and on its own 10% tint), so it maps to the
  // failed state's text color, which must clear 4.5:1, not to the 3:1 solid.
  destructive: { semantic: "state-failed-text" },
  border: { semantic: "border" },
  input: { semantic: "border-strong" },
  ring: { semantic: "focus-ring" },
};

/**
 * Light surfaces stay on paper and rise with shadows; dark surfaces rise by getting lighter
 * (the dark theme's elevation adds borders and a faint inner highlight).
 */
const SURFACE_STEPS: Readonly<
  Record<Mode, Readonly<Record<"bg" | "bg-subtle" | "surface" | "surface-raised", Step>>>
> = {
  light: { bg: 1, "bg-subtle": 2, surface: 1, "surface-raised": 1 },
  dark: { bg: 1, "bg-subtle": 2, surface: 2, "surface-raised": 3 },
};

export interface ThemeMode {
  readonly mode: Mode;
  readonly ramps: Readonly<Record<RampName, Ramp>>;
  readonly semantic: Readonly<Record<SemanticName, SemanticColor>>;
  readonly shadcn: Readonly<Record<ShadcnName, AliasTarget>>;
}

export interface Theme {
  readonly inputs: ThemeInputs;
  readonly light: ThemeMode;
  readonly dark: ThemeMode;
}

export function generateTheme(inputs: ThemeInputs = DEFAULT_INPUTS): Theme {
  const checked = validateInputs(inputs);
  return { inputs: checked, light: buildMode("light", checked), dark: buildMode("dark", checked) };
}

/** One mode's lightness curve after `contrast` moves steps 6–8 and 11–12. */
export function lightnessCurve(mode: Mode, contrast: number): number[] {
  const push = (contrast - 50) / 50; // −1: toward the background · +1: away from it
  const away = mode === "light" ? -1 : 1;
  return LIGHTNESS[mode].map((l, i) => {
    const moved = l + away * push * (CONTRAST_REACH[i] ?? 0);
    return Math.min(1, Math.max(0, Math.round(moved * 1e4) / 1e4));
  });
}

export function stepOf(ramp: Ramp, step: Step): Swatch {
  const color = ramp[step - 1];
  if (!color) throw new Error(`ramp has no step ${step}`);
  return color;
}

/** Throws a RangeError for out-of-range inputs; returns them with hues normalized to 0–360. */
export function validateInputs(inputs: ThemeInputs): ThemeInputs {
  const { base, accent, contrast } = inputs;
  check("base hue", base.hue, -Infinity, Infinity);
  check("base chroma", base.chroma, 0, 0.4);
  check("accent lightness", accent.l, 0, 1);
  check("accent chroma", accent.c, 0, 0.4);
  check("accent hue", accent.h, -Infinity, Infinity);
  check("contrast", contrast, 0, 100);
  return {
    base: { hue: normalizeHue(base.hue), chroma: base.chroma },
    accent: { l: accent.l, c: accent.c, h: normalizeHue(accent.h) },
    contrast,
  };
}

function check(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    const range = Number.isFinite(min) ? ` from ${min} to ${max}` : "";
    throw new RangeError(`${name} must be a finite number${range}, got ${value}`);
  }
}

function buildRamp(lightness: readonly number[], chroma: readonly number[], hue: number): Swatch[] {
  return lightness.map((l, i) => swatch(l, chroma[i] ?? 0, hue));
}

/** Walks lightness from `start` in 0.005 steps until `accept` passes or the range ends. */
function walkLightness(
  start: number,
  direction: 1 | -1,
  chroma: number,
  hue: number,
  accept: (color: Swatch) => boolean,
): { l: number; color: Swatch; nudges: number } {
  for (let nudges = 0; ; nudges++) {
    const l = Math.min(1, Math.max(0, start + direction * nudges * SOLVE_STEP));
    const color = swatch(l, chroma, hue);
    if (accept(color) || l === 0 || l === 1) return { l, color, nudges };
  }
}

function buildMode(mode: Mode, inputs: ThemeInputs): ThemeMode {
  const lightness = lightnessCurve(mode, inputs.contrast);
  const scaled = (shares: readonly number[], chroma: number) => shares.map((s) => s * chroma);
  const stateRamp = (state: StateName) =>
    buildRamp(lightness, scaled(COLOR_CHROMA, STATE_CHROMA), STATE_HUES[state]);

  const neutralChroma = scaled(NEUTRAL_CHROMA, inputs.base.chroma);
  const accentChroma = scaled(COLOR_CHROMA, inputs.accent.c);
  const neutral = buildRamp(lightness, neutralChroma, inputs.base.hue);
  const accent = buildRamp(lightness, accentChroma, inputs.accent.h);

  // Step 8 carries border-strong (neutral) and focus-ring (accent), which must reach 3:1 on bg
  // (WCAG 1.4.11). The curve passes for the tested inputs, so there this changes nothing; it
  // covers the rest of the input space, such as a luminous green accent on heavily tinted
  // neutrals, by moving step 8 away from the background until it passes.
  const bg = stepOf(neutral, 1);
  const away = mode === "light" ? -1 : 1;
  const step8 = lightness[7] ?? 0;
  const passes = (color: Swatch) => worstContrast(color, bg) >= NON_TEXT_CONTRAST;
  neutral[7] = walkLightness(step8, away, neutralChroma[7] ?? 0, inputs.base.hue, passes).color;
  accent[7] = walkLightness(step8, away, accentChroma[7] ?? 0, inputs.accent.h, passes).color;

  const solids = solveAccent(mode, inputs.accent, neutral);
  accent[8] = solids.solid;
  accent[9] = solids.hover;

  const ramps: Record<RampName, Ramp> = {
    neutral,
    accent,
    proposed: stateRamp("proposed"),
    conflict: stateRamp("conflict"),
    synced: stateRamp("synced"),
    failed: stateRamp("failed"),
  };
  const refs = semanticRefs(mode, solids.onAccent);
  const semantic = Object.fromEntries(
    SEMANTIC_NAMES.map((name) => {
      const ref = refs[name];
      return [name, { ...ref, ...stepOf(ramps[ref.ramp], ref.step) }];
    }),
  ) as Record<SemanticName, SemanticColor>;

  return { mode, ramps, semantic, shadcn: SHADCN };
}

interface AccentSolids {
  solid: Swatch;
  hover: Swatch;
  /** The neutral step the accent's text uses: 1 (the background) or 12 (the text color). */
  onAccent: Step;
}

/**
 * Pins the accent's solid fill (step 9) to the accent's own lightness, then nudges it, in
 * 0.005 steps, just far enough for its text to reach 4.5:1 on sRGB and P3 screens alike. The
 * text is the background or the text color of the same mode, whichever needs the smaller
 * nudge, so ink buttons get paper text and paper buttons get ink text.
 */
function solveAccent(mode: Mode, accent: ThemeInputs["accent"], neutral: Ramp): AccentSolids {
  const target = mode === "light" ? accent.l : Math.max(accent.l, ACCENT_MIRROR - accent.l);
  const candidates = ([1, 12] as const).map((step) => {
    const text = stepOf(neutral, step);
    const direction = text.oklch[0] > target ? -1 : 1;
    const accepts = (color: Swatch) => worstContrast(text, color) >= TEXT_CONTRAST;
    const { l, color, nudges } = walkLightness(target, direction, accent.c, accent.h, accepts);
    return { step, text, l, solid: color, nudges, ratio: worstContrast(text, color) };
  });
  const [first, second] = candidates;
  if (!first || !second) throw new Error("unreachable: two on-accent candidates");
  const best =
    first.nudges < second.nudges || (first.nudges === second.nudges && first.ratio >= second.ratio)
      ? first
      : second;

  // Hover moves the way the curve's own step 10 does (darker in light, lighter in dark), or
  // the other way when that would leave the range or drop the text below 4.5:1.
  const move = (LIGHTNESS[mode][9] ?? 0) - (LIGHTNESS[mode][8] ?? 0);
  let hover = best.solid;
  for (const delta of [move, -move]) {
    const l = best.l + delta;
    if (l < 0.05 || l > 0.98) continue;
    const candidate = swatch(l, accent.c, accent.h);
    if (worstContrast(best.text, candidate) >= TEXT_CONTRAST) {
      hover = candidate;
      break;
    }
  }
  return { solid: best.solid, hover, onAccent: best.step };
}

function semanticRefs(mode: Mode, onAccent: Step): Record<SemanticName, RampRef> {
  const neutral = (step: Step): RampRef => ({ ramp: "neutral", step });
  const accent = (step: Step): RampRef => ({ ramp: "accent", step });
  const surfaces = SURFACE_STEPS[mode];
  const states = Object.fromEntries(
    STATE_NAMES.flatMap((state) =>
      STATE_ROLES.map((role) => [
        `state-${state}-${role}`,
        { ramp: state, step: STATE_ROLE_STEPS[role] },
      ]),
    ),
  ) as Record<`state-${StateName}-${StateRole}`, RampRef>;
  return {
    bg: neutral(surfaces.bg),
    "bg-subtle": neutral(surfaces["bg-subtle"]),
    surface: neutral(surfaces.surface),
    "surface-raised": neutral(surfaces["surface-raised"]),
    border: neutral(6),
    "border-strong": neutral(8),
    text: neutral(12),
    "text-muted": neutral(11),
    accent: accent(9),
    "accent-hover": accent(10),
    "on-accent": neutral(onAccent),
    "focus-ring": accent(8),
    ...states,
  };
}
