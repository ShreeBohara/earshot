import Color from "colorjs.io";
import { describe, expect, it } from "vitest";
import { isWideGamut, MODES, type SemanticName, STATE_NAMES, type Swatch } from "../src";
import { p3Css } from "../src/color";
import { INPUT_SET_NAMES, themeFor } from "./inputs";

// The spec's table: 4.5:1 for text (WCAG 1.4.3), 3:1 for non-text UI (WCAG 1.4.11).
const PAIRS: readonly (readonly [fg: SemanticName, bg: SemanticName, min: number])[] = [
  ...(["text", "text-muted"] as const).flatMap((fg) =>
    (["bg", "surface", "surface-raised"] as const).map((bg) => [fg, bg, 4.5] as const),
  ),
  ["on-accent", "accent", 4.5],
  ...STATE_NAMES.map((state) => [`state-${state}-text`, `state-${state}-bg`, 4.5] as const),
  ["border-strong", "bg", 3],
  ["focus-ring", "bg", 3],
  ...STATE_NAMES.map((state) => [`state-${state}-solid`, "bg", 3] as const),
];

const cases = INPUT_SET_NAMES.flatMap((set) =>
  MODES.flatMap((mode) => PAIRS.map(([fg, bg, min]) => ({ set, mode, fg, bg, min }))),
);

/** What an sRGB screen shows: the hex. */
const onSrgb = (swatch: Swatch) => new Color(swatch.hex);
/** What a P3 screen shows: the emitted P3 override when there is one, else the hex. */
const onP3 = (swatch: Swatch) =>
  isWideGamut(swatch.oklch) ? new Color(p3Css(swatch.oklch)) : new Color(swatch.hex);

describe("WCAG 2.1 contrast, computed with colorjs.io", () => {
  // `it.for` (unlike `it.each`) passes the test context, for `annotate`.
  it.for(cases)(
    "$set · $mode · $fg on $bg ≥ $min:1",
    async ({ set, mode, fg, bg, min }, { annotate }) => {
      const theme = themeFor(set)[mode];
      const [text, background] = [theme.semantic[fg], theme.semantic[bg]];

      expect(onSrgb(text).contrast(onSrgb(background), "WCAG21")).toBeGreaterThanOrEqual(min);
      expect(onP3(text).contrast(onP3(background), "WCAG21")).toBeGreaterThanOrEqual(min);

      // APCA is reported for information only.
      const lc = onSrgb(background).contrast(onSrgb(text), "APCA");
      await annotate(`APCA Lc ${lc.toFixed(1)}`);
    },
  );
});
