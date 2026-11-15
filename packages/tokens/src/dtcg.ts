// DTCG 2025.10 token types, Earshot's hand-written tokens, and the generated theme files.
import { round, type Swatch } from "./color";
import {
  type AliasTarget,
  type Mode,
  RAMP_NAMES,
  type RampRef,
  SEMANTIC_NAMES,
  type SemanticName,
  SHADCN_NAMES,
  type ShadcnName,
  STATE_NAMES,
  STATE_ROLES,
  STEPS,
  type StateName,
  type StateRole,
  stepOf,
  type Theme,
  type ThemeInputs,
  type ThemeMode,
  validateInputs,
} from "./generate";

/** A reference to another token by its path, for example `{color.neutral.1}`. */
export type DtcgReference = `{${string}}`;

export interface DtcgColor {
  readonly colorSpace: "oklch";
  readonly components: readonly [number, number, number];
  readonly alpha?: number;
  /** The sRGB fallback, gamut-mapped when `components` is wider than sRGB. */
  readonly hex: string;
}

export interface DtcgDimension {
  readonly value: number;
  readonly unit: "px" | "rem";
}

export interface DtcgDuration {
  readonly value: number;
  readonly unit: "ms" | "s";
}

export type DtcgCubicBezier = readonly [number, number, number, number];

export interface DtcgShadow {
  readonly color: DtcgColor | DtcgReference;
  readonly offsetX: DtcgDimension;
  readonly offsetY: DtcgDimension;
  readonly blur: DtcgDimension;
  readonly spread: DtcgDimension;
  readonly inset?: boolean;
}

export interface DtcgTypography {
  readonly fontFamily: readonly string[] | DtcgReference;
  readonly fontSize: DtcgDimension | DtcgReference;
  readonly fontWeight: number | DtcgReference;
  readonly letterSpacing: DtcgDimension | DtcgReference;
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
}

interface TokenOf<Type extends string, Value> {
  readonly $type: Type;
  readonly $value: Value | DtcgReference;
  readonly $description?: string;
  readonly $extensions?: Readonly<Record<string, unknown>>;
}

export type DtcgToken =
  | TokenOf<"color", DtcgColor>
  | TokenOf<"dimension", DtcgDimension>
  | TokenOf<"duration", DtcgDuration>
  | TokenOf<"cubicBezier", DtcgCubicBezier>
  | TokenOf<"fontFamily", string | readonly string[]>
  | TokenOf<"fontWeight", number>
  | TokenOf<"number", number>
  | TokenOf<"shadow", DtcgShadow | readonly DtcgShadow[]>
  | TokenOf<"typography", DtcgTypography>;

export type DtcgTokenType = DtcgToken["$type"];
type TokenOfType<Type extends DtcgTokenType> = Extract<DtcgToken, { $type: Type }>;

export interface DtcgGroup {
  readonly [name: string]: DtcgToken | DtcgGroup;
}

/** One `*.tokens.json` file: its root `$description` and `$extensions`, plus its groups. */
export interface DtcgFile {
  readonly description: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly tokens: DtcgGroup;
}

export const SHARED_FILE_NAMES = ["typography", "space", "radius", "motion", "size"] as const;
export const TOKEN_FILE_NAMES = ["light", "dark", ...SHARED_FILE_NAMES] as const;
export type TokenFileName = (typeof TOKEN_FILE_NAMES)[number];
export type TokenFiles = Readonly<Record<TokenFileName, DtcgFile>>;

export function isReference(value: unknown): value is DtcgReference {
  return typeof value === "string" && /^\{[^{}]+\}$/.test(value);
}

export function isToken(node: DtcgToken | DtcgGroup): node is DtcgToken {
  return "$value" in node;
}

// ─── Hand-written tokens ────────────────────────────────────────────────────────────────

const px = (value: number): DtcgDimension => ({ value, unit: "px" });

function token<Type extends DtcgTokenType>(
  $type: Type,
  $value: TokenOfType<Type>["$value"],
  $description?: string,
): TokenOfType<Type> {
  return (
    $description === undefined ? { $type, $value } : { $type, $value, $description }
  ) as TokenOfType<Type>;
}

function keyed<const Key extends string | number, Value>(
  keys: readonly Key[],
  make: (key: Key) => Value,
): Record<Key, Value> {
  return Object.fromEntries(keys.map((key) => [key, make(key)])) as Record<Key, Value>;
}

/** Font size and line height in px. 14/20 is body text; 30 and up is display. */
export const TYPE_SCALE = [
  [12, 16],
  [13, 18],
  [14, 20],
  [16, 24],
  [18, 26],
  [20, 28],
  [24, 32],
  [30, 36],
  [36, 40],
  [48, 52],
  [60, 64],
] as const;
type TypeSize = (typeof TYPE_SCALE)[number][0];
type DisplaySize = Extract<TypeSize, 30 | 36 | 48 | 60>;

const DISPLAY_FROM = 30;
const TYPE_SIZES = TYPE_SCALE.map(([size]) => size);
const DISPLAY_SIZES = TYPE_SIZES.filter((size): size is DisplaySize => size >= DISPLAY_FROM);
const lineHeightOf = (size: TypeSize) => TYPE_SCALE.find(([s]) => s === size)?.[1] ?? size;

/**
 * Display tracking runs from −0.01em at 30px to −0.02em at 60px. It's stored in px because a
 * DTCG dimension is px or rem.
 */
function displayTracking(size: number): number {
  return round(size * (-0.01 - (0.01 * (size - DISPLAY_FROM)) / (60 - DISPLAY_FROM)), 2);
}

export const typographyTokens = {
  font: {
    serif: token(
      "fontFamily",
      ["Instrument Serif", "ui-serif", "Georgia", "serif"],
      "Display sizes, 30px and up, with −0.01 to −0.02em tracking.",
    ),
    sans: token(
      "fontFamily",
      ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
      "The interface.",
    ),
    mono: {
      ...token(
        "fontFamily",
        ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        "Data and evidence, with tabular numbers.",
      ),
      $extensions: { earshot: { fontVariantNumeric: "tabular-nums" } },
    },
    weight: {
      regular: token("fontWeight", 400),
      medium: token("fontWeight", 500),
      semibold: token("fontWeight", 600),
    },
    size: keyed(TYPE_SIZES, (size) => token("dimension", px(size))),
    "line-height": keyed(TYPE_SIZES, (size) => token("dimension", px(lineHeightOf(size)))),
    tracking: keyed(DISPLAY_SIZES, (size) => token("dimension", px(displayTracking(size)))),
  },
  type: keyed(TYPE_SIZES, (size) => {
    const display = size >= DISPLAY_FROM;
    return token("typography", {
      fontFamily: display ? "{font.serif}" : "{font.sans}",
      fontSize: `{font.size.${size}}`,
      fontWeight: "{font.weight.regular}",
      letterSpacing: display ? `{font.tracking.${size}}` : px(0),
      lineHeight: round(lineHeightOf(size) / size, 4),
    });
  }),
} satisfies DtcgGroup;

/** A 4px grid. */
const SPACE_STEPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24] as const;
export const spaceTokens = {
  space: keyed(SPACE_STEPS, (step) => token("dimension", px(step * 4))),
} satisfies DtcgGroup;

export const radiusTokens = {
  radius: {
    sm: token("dimension", px(4)),
    md: token("dimension", px(6)),
    lg: token("dimension", px(10)),
    xl: token("dimension", px(14)),
    full: token("dimension", px(9999)),
  },
} satisfies DtcgGroup;

const ms = (value: number): DtcgDuration => ({ value, unit: "ms" });
export const motionTokens = {
  duration: {
    fast: token("duration", ms(120)),
    medium: token("duration", ms(180)),
    slow: token("duration", ms(240)),
    reduced: token(
      "duration",
      ms(120),
      "The cap under prefers-reduced-motion, where every animation becomes an opacity fade.",
    ),
  },
  easing: {
    standard: token("cubicBezier", [0.2, 0, 0, 1]),
    exit: token("cubicBezier", [0.4, 0, 1, 1]),
  },
} satisfies DtcgGroup;

export const sizeTokens = {
  size: {
    control: {
      sm: token("dimension", px(32)),
      md: token("dimension", px(36)),
      lg: token("dimension", px(44), "Touch."),
    },
    target: {
      min: token("dimension", px(24), "The smallest hit target (WCAG 2.5.8)."),
    },
  },
} satisfies DtcgGroup;

// ─── Generated theme tokens ─────────────────────────────────────────────────────────────

function colorValue(color: Swatch, alpha?: number): DtcgColor {
  const [l, c, h] = color.oklch;
  return alpha === undefined
    ? { colorSpace: "oklch", components: [l, c, h], hex: color.hex }
    : { colorSpace: "oklch", components: [l, c, h], alpha, hex: color.hex };
}

const rampPath = (ref: RampRef): DtcgReference => `{color.${ref.ramp}.${ref.step}}`;
const aliasPath = (target: AliasTarget): DtcgReference =>
  "semantic" in target ? `{semantic.${target.semantic}}` : rampPath(target);

const SEMANTIC_DESCRIPTIONS: Readonly<Record<string, string>> = {
  bg: "Page background.",
  "bg-subtle": "Subtle background: sidebars, table stripes, code blocks.",
  surface: "Cards and panels.",
  "surface-raised": "Popovers, menus, dialogs, and toasts.",
  border: "Hairlines: card edges and dividers.",
  "border-strong": "Input borders and other component edges. At least 3:1 on bg.",
  text: "Body text.",
  "text-muted": "Secondary text. At least 4.5:1 on bg, surface, and surface-raised.",
  accent: "Primary actions: ink on paper in light, paper on ink in dark.",
  "accent-hover": "Hover state of accent.",
  "on-accent": "Text and icons on accent. At least 4.5:1.",
  "focus-ring": "Focus rings. At least 3:1 on bg.",
};

const STATE_LABELS: Readonly<Record<StateName, string>> = {
  proposed: "Proposed (blue)",
  conflict: "Conflict (amber)",
  synced: "Synced (green)",
  failed: "Failed (red)",
};

const STATE_ROLE_LABELS: Readonly<Record<StateRole, string>> = {
  bg: "soft background",
  border: "border",
  text: "text on its soft background, at least 4.5:1",
  solid: "solid fill for dots, icons, and strong pills, at least 3:1 on bg",
};

function semanticDescription(name: SemanticName): string {
  for (const state of STATE_NAMES) {
    for (const role of STATE_ROLES) {
      if (name === `state-${state}-${role}`)
        return `${STATE_LABELS[state]}: ${STATE_ROLE_LABELS[role]}.`;
    }
  }
  return SEMANTIC_DESCRIPTIONS[name] ?? "";
}

const SHADCN_DESCRIPTIONS: Partial<Record<ShadcnName, string>> = {
  primary: "Earshot's accent.",
  accent: "shadcn's subtle hover fill (neutral step 4), not the brand color. That's --primary.",
};

function shadow(
  color: DtcgColor | DtcgReference,
  [x, y, blur, spread]: readonly [number, number, number, number],
  inset = false,
): DtcgShadow {
  const geometry = { offsetX: px(x), offsetY: px(y), blur: px(blur), spread: px(spread) };
  return inset ? { color, ...geometry, inset } : { color, ...geometry };
}

/** Two shadows in light. Dark uses a hairline border and a faint inner highlight instead. */
function elevationTokens(theme: ThemeMode): DtcgGroup {
  if (theme.mode === "light") {
    const shade = (alpha: number) => colorValue(stepOf(theme.ramps.neutral, 12), alpha);
    return {
      "1": token(
        "shadow",
        [shadow(shade(0.06), [0, 1, 2, 0]), shadow(shade(0.08), [0, 1, 3, 0])],
        "Cards and other resting surfaces.",
      ),
      "2": token(
        "shadow",
        [shadow(shade(0.08), [0, 4, 8, -2]), shadow(shade(0.12), [0, 12, 24, -4])],
        "Popovers, menus, dialogs, and toasts.",
      ),
    };
  }
  const highlight = (alpha: number): DtcgColor => ({
    colorSpace: "oklch",
    components: [1, 0, 0],
    alpha,
    hex: "#ffffff",
  });
  return {
    "1": token(
      "shadow",
      [shadow("{color.neutral.6}", [0, 0, 0, 1]), shadow(highlight(0.04), [0, 1, 0, 0], true)],
      "Cards and other resting surfaces.",
    ),
    "2": token(
      "shadow",
      [shadow("{color.neutral.7}", [0, 0, 0, 1]), shadow(highlight(0.06), [0, 1, 0, 0], true)],
      "Popovers, menus, dialogs, and toasts.",
    ),
  };
}

/** The DTCG tokens for one mode: ramps, the semantic layer, shadcn aliases, and elevation. */
export function themeTokens(theme: ThemeMode): DtcgGroup {
  return {
    color: keyed(RAMP_NAMES, (ramp) =>
      keyed(STEPS, (step) => token("color", colorValue(stepOf(theme.ramps[ramp], step)))),
    ),
    semantic: keyed(SEMANTIC_NAMES, (name) =>
      token("color", rampPath(theme.semantic[name]), semanticDescription(name)),
    ),
    shadcn: keyed(SHADCN_NAMES, (name) =>
      token("color", aliasPath(theme.shadcn[name]), SHADCN_DESCRIPTIONS[name]),
    ),
    elevation: elevationTokens(theme),
  };
}

const REGENERATE = "Generated by `pnpm --filter @earshot/tokens theme`. Don't edit by hand.";

function themeFile(theme: ThemeMode, inputs: ThemeInputs): DtcgFile {
  return {
    description: `Earshot's ${theme.mode} theme: color ramps, the semantic layer, shadcn/ui aliases, and elevation. ${REGENERATE}`,
    extensions: { earshot: { mode: theme.mode, inputs } },
    tokens: themeTokens(theme),
  };
}

function sharedFile(what: string, tokens: DtcgGroup): DtcgFile {
  return { description: `Earshot's ${what}. Hand-written in src/dtcg.ts. ${REGENERATE}`, tokens };
}

/** Every `tokens/*.tokens.json` file for a theme, keyed by file name. */
export function tokenFiles(theme: Theme): TokenFiles {
  return {
    light: themeFile(theme.light, theme.inputs),
    dark: themeFile(theme.dark, theme.inputs),
    typography: sharedFile(
      "type: families, weights, the type scale, and display tracking",
      typographyTokens,
    ),
    space: sharedFile("spacing, on a 4px grid", spaceTokens),
    radius: sharedFile("corner radii", radiusTokens),
    motion: sharedFile("motion durations and easings", motionTokens),
    size: sharedFile("control heights and the minimum hit target", sizeTokens),
  };
}

/** The theme inputs a generated theme file records in `$extensions.earshot.inputs`. */
export function themeInputsOf(file: DtcgFile): ThemeInputs {
  const earshot = file.extensions?.earshot;
  const inputs = isObject(earshot) ? earshot.inputs : undefined;
  if (!isObject(inputs) || !isObject(inputs.base) || !isObject(inputs.accent)) {
    throw new Error("token file has no $extensions.earshot.inputs");
  }
  const { base, accent } = inputs;
  return validateInputs({
    base: { hue: Number(base.hue), chroma: Number(base.chroma) },
    accent: { l: Number(accent.l), c: Number(accent.c), h: Number(accent.h) },
    contrast: Number(inputs.contrast),
  });
}

/** The mode a generated theme file records in `$extensions.earshot.mode`. */
export function themeModeOf(file: DtcgFile): Mode | undefined {
  const earshot = file.extensions?.earshot;
  const mode = isObject(earshot) ? earshot.mode : undefined;
  return mode === "light" || mode === "dark" ? mode : undefined;
}

// ─── Reading and writing ────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeTokenFile(file: DtcgFile): string {
  const root = file.extensions
    ? { $description: file.description, $extensions: file.extensions, ...file.tokens }
    : { $description: file.description, ...file.tokens };
  return `${formatJson(root)}\n`;
}

export function parseTokenFile(text: string): DtcgFile {
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || typeof data.$description !== "string") {
    throw new Error("not a token file: the root needs a $description");
  }
  const { $description, $extensions, ...tokens } = data;
  return isObject($extensions)
    ? { description: $description, extensions: $extensions, tokens: tokens as DtcgGroup }
    : { description: $description, tokens: tokens as DtcgGroup };
}

const LINE_WIDTH = 100;

/**
 * JSON laid out the way Biome formats it, so generated files pass `pnpm check` untouched:
 * objects always expanded, arrays of scalars on one line when they fit in 100 columns.
 */
export function formatJson(value: unknown, depth = 0, column = 0, trailing = 0): string {
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (column + inline.length + trailing <= LINE_WIDTH) return inline;
    }
    const items = value.map(
      (item, i) => inner + formatJson(item, depth + 1, inner.length, i < value.length - 1 ? 1 : 0),
    );
    return `[\n${items.join(",\n")}\n${outer}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([key, item], i) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      return head + formatJson(item, depth + 1, head.length, i < entries.length - 1 ? 1 : 0);
    });
    return `{\n${lines.join(",\n")}\n${outer}}`;
  }
  return JSON.stringify(value);
}
