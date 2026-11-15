// The contrast pairs the spec requires, checked on sRGB and P3 screens.
import { apcaContrast, p3Contrast, wcagContrast } from "./color";
import { type SemanticName, STATE_NAMES, type ThemeMode } from "./generate";

export interface ContrastPair {
  readonly fg: SemanticName;
  readonly bg: SemanticName;
  /** 4.5 for text (WCAG 1.4.3), 3 for borders and other non-text UI (WCAG 1.4.11). */
  readonly min: number;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(["text", "text-muted"] as const).flatMap((fg) =>
    (["bg", "surface", "surface-raised"] as const).map((bg) => ({ fg, bg, min: 4.5 })),
  ),
  { fg: "on-accent", bg: "accent", min: 4.5 },
  ...STATE_NAMES.map(
    (state) => ({ fg: `state-${state}-text`, bg: `state-${state}-bg`, min: 4.5 }) as const,
  ),
  ...STATE_NAMES.map((state) => ({ fg: `state-${state}-text`, bg: "bg", min: 4.5 }) as const),
  { fg: "border-strong", bg: "bg", min: 3 },
  { fg: "focus-ring", bg: "bg", min: 3 },
  ...STATE_NAMES.map((state) => ({ fg: `state-${state}-solid`, bg: "bg", min: 3 }) as const),
];

export interface ContrastResult extends ContrastPair {
  /** WCAG 2.1 ratio from the hex values. */
  readonly srgb: number;
  /** WCAG 2.1 ratio with the P3 overrides applied. */
  readonly p3: number;
  /** APCA Lc, for information only. */
  readonly apca: number;
  readonly pass: boolean;
}

export function checkContrast(theme: ThemeMode): ContrastResult[] {
  return CONTRAST_PAIRS.map((pair) => {
    const fg = theme.semantic[pair.fg];
    const bg = theme.semantic[pair.bg];
    const srgb = wcagContrast(fg.hex, bg.hex);
    const p3 = p3Contrast(fg, bg);
    return {
      ...pair,
      srgb,
      p3,
      apca: apcaContrast(fg.hex, bg.hex),
      pass: Math.min(srgb, p3) >= pair.min,
    };
  });
}
