// Color math for the generator and the build, on colorjs.io's tree-shakeable API.
import {
  ColorSpace,
  contrastAPCA,
  contrastWCAG21,
  inGamut,
  OKLCH,
  P3,
  type PlainColorObject,
  sRGB,
  to,
  toGamut,
} from "colorjs.io/fn";

// The tree-shakeable API only knows the spaces it's given; APCA looks up "srgb" by id.
ColorSpace.register(sRGB);

/** OKLCH lightness (0–1), chroma (0 to about 0.4), and hue (degrees). */
export type Oklch = readonly [l: number, c: number, h: number];

/** One generated color, in the two shapes a DTCG color token stores. */
export interface Swatch {
  /**
   * OKLCH after CSS Color 4 gamut mapping into Display P3, rounded: the DTCG `components`.
   * On a P3 screen it can be more saturated than `hex`.
   */
  readonly oklch: Oklch;
  /** The same color gamut-mapped into sRGB (CSS Color 4), as `#rrggbb`: the DTCG `hex`. */
  readonly hex: string;
}

/**
 * How far outside sRGB (per channel, on a 0–1 scale) a color must sit before it gets a P3
 * override. Rounding the components moves a color by about 1e-4; real overflows from the
 * generator are 0.01 and up.
 */
const SRGB_TOLERANCE = 0.0005;

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function channel(value: number | null): number {
  return clamp(value ?? 0, 0, 1);
}

function oklchColor([l, c, h]: Oklch): PlainColorObject {
  return { space: OKLCH, coords: [l, c, h], alpha: 1 };
}

/** The 0–255 channels of a `#rrggbb` color. */
export function hexBytes(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`expected a #rrggbb color, got ${hex}`);
  const [r, g, b] = match.slice(1).map((pair) => Number.parseInt(pair, 16));
  return [r ?? 0, g ?? 0, b ?? 0];
}

function hexColor(hex: string): PlainColorObject {
  const [r, g, b] = hexBytes(hex).map((byte) => byte / 255);
  return { space: sRGB, coords: [r ?? 0, g ?? 0, b ?? 0], alpha: 1 };
}

/** `#rrggbb` for the CSS Color 4 sRGB gamut mapping of an OKLCH color. */
export function srgbHex(oklch: Oklch): string {
  const mapped = to(toGamut(oklchColor(oklch), { space: sRGB, method: "css" }), sRGB);
  const bytes = mapped.coords.map((value) => Math.round(channel(value) * 255));
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Builds a swatch from a requested OKLCH color: gamut-maps it into Display P3 with the CSS
 * Color 4 algorithm (lightness and hue held, chroma reduced), rounds it, then maps that
 * into sRGB for the hex fallback.
 */
export function swatch(l: number, c: number, h: number): Swatch {
  const hue = normalizeHue(h);
  const requested = oklchColor([clamp(l, 0, 1), Math.max(0, c), hue]);
  const [ml, mc, mh] = toGamut(requested, { space: P3, method: "css" }).coords;
  const chroma = round(Math.max(0, mc ?? 0), 4);
  // Hue is powerless at zero chroma (colorjs reports NaN), so keep the requested one.
  const mappedHue = chroma === 0 || mh === null || Number.isNaN(mh) ? hue : mh;
  const oklch: Oklch = [round(ml ?? l, 4), chroma, round(normalizeHue(mappedHue), 2)];
  return { oklch, hex: srgbHex(oklch) };
}

/** True when a color sits visibly outside sRGB, so P3 screens get a different color. */
export function isWideGamut(oklch: Oklch): boolean {
  return !inGamut(oklchColor(oklch), sRGB, { epsilon: SRGB_TOLERANCE });
}

/** Display P3 channels of an OKLCH color, clamped into the gamut and rounded as CSS prints them. */
function p3Channels(oklch: Oklch): [number, number, number] {
  const [r, g, b] = to(oklchColor(oklch), P3).coords.map((value) => round(channel(value), 4));
  return [r ?? 0, g ?? 0, b ?? 0];
}

/** `color(display-p3 r g b)` for an OKLCH color, clamped into the P3 gamut. */
export function p3Css(oklch: Oklch, alpha = 1): string {
  const rgb = p3Channels(oklch).join(" ");
  return alpha < 1 ? `color(display-p3 ${rgb} / ${alpha})` : `color(display-p3 ${rgb})`;
}

/** The color a Display P3 screen shows: the P3 override when there is one, else the hex. */
function onP3Screen(color: Swatch): PlainColorObject {
  return isWideGamut(color.oklch)
    ? { space: P3, coords: p3Channels(color.oklch), alpha: 1 }
    : hexColor(color.hex);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colors. */
export function wcagContrast(a: string, b: string): number {
  return contrastWCAG21(hexColor(a), hexColor(b));
}

/** WCAG 2.1 contrast of a pair as a Display P3 screen shows it, P3 overrides applied. */
export function p3Contrast(a: Swatch, b: Swatch): number {
  return contrastWCAG21(onP3Screen(a), onP3Screen(b));
}

/** The lower of a pair's sRGB and P3 contrast: what the pair is guaranteed on any screen. */
export function worstContrast(a: Swatch, b: Swatch): number {
  return Math.min(wcagContrast(a.hex, b.hex), p3Contrast(a, b));
}

/** APCA lightness contrast (Lc) of text on a background, both `#rrggbb`. Informational. */
export function apcaContrast(text: string, background: string): number {
  return contrastAPCA(hexColor(background), hexColor(text));
}
