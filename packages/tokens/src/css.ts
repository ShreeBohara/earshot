// Builds tokens.css and tokens.json from the DTCG token files.
import { hexBytes, isWideGamut, p3Css } from "./color";
import {
  type DtcgColor,
  type DtcgDimension,
  type DtcgGroup,
  type DtcgReference,
  type DtcgShadow,
  type DtcgToken,
  formatJson,
  isReference,
  isToken,
  SHARED_FILE_NAMES,
  type TokenFiles,
  themeInputsOf,
  themeModeOf,
} from "./dtcg";
import type { ThemeInputs } from "./generate";

export interface TokenEntry {
  readonly path: readonly string[];
  readonly token: DtcgToken;
}

type Gamut = "srgb" | "p3";
type Declaration = readonly [property: string, value: string];

/** Every token in a group, depth first, in file order. */
export function flatten(group: DtcgGroup, prefix: readonly string[] = []): TokenEntry[] {
  return Object.entries(group).flatMap(([key, node]) =>
    isToken(node) ? [{ path: [...prefix, key], token: node }] : flatten(node, [...prefix, key]),
  );
}

/**
 * The custom property for a token path. Ramps and the semantic layer drop their group name
 * (`--es-neutral-1`, `--es-bg`); shadcn aliases drop the `es` prefix too (`--background`).
 */
export function cssName(path: readonly string[]): string {
  const [group = "", ...rest] = path;
  if (group === "shadcn") return `--${rest.join("-")}`;
  if (group === "color" || group === "semantic") return `--es-${rest.join("-")}`;
  return `--es-${path.join("-")}`;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

function reference(ref: DtcgReference): string {
  return `var(${cssName(ref.slice(1, -1).split("."))})`;
}

function color(value: DtcgColor | DtcgReference, gamut: Gamut): string {
  if (isReference(value)) return reference(value);
  const alpha = value.alpha ?? 1;
  if (gamut === "p3" && isWideGamut(value.components)) return p3Css(value.components, alpha);
  return alpha < 1 ? `rgb(${hexBytes(value.hex).join(" ")} / ${alpha})` : value.hex;
}

function dimension(value: DtcgDimension | DtcgReference): string {
  return isReference(value) ? reference(value) : `${value.value}${value.unit}`;
}

function shadow(value: DtcgShadow, gamut: Gamut): string {
  const geometry = [value.offsetX, value.offsetY, value.blur, value.spread].map(dimension);
  return `${value.inset ? "inset " : ""}${geometry.join(" ")} ${color(value.color, gamut)}`;
}

function isShadowList(value: DtcgShadow | readonly DtcgShadow[]): value is readonly DtcgShadow[] {
  return Array.isArray(value);
}

/** A token's CSS value, or null for typography composites (CSS gets their parts instead). */
export function cssValue(token: DtcgToken, gamut: Gamut = "srgb"): string | null {
  switch (token.$type) {
    case "color":
      return color(token.$value, gamut);
    case "dimension":
      return dimension(token.$value);
    case "duration":
      return isReference(token.$value)
        ? reference(token.$value)
        : `${token.$value.value}${token.$value.unit}`;
    case "cubicBezier":
      return isReference(token.$value)
        ? reference(token.$value)
        : `cubic-bezier(${token.$value.join(", ")})`;
    case "fontFamily": {
      const value = token.$value;
      if (isReference(value)) return reference(value);
      const names = typeof value === "string" ? [value] : value;
      return names
        .map((name) => (GENERIC_FAMILIES.has(name) ? name : JSON.stringify(name)))
        .join(", ");
    }
    case "fontWeight":
    case "number":
      return isReference(token.$value) ? reference(token.$value) : String(token.$value);
    case "shadow": {
      const value = token.$value;
      if (isReference(value)) return reference(value);
      return (isShadowList(value) ? value : [value]).map((s) => shadow(s, gamut)).join(", ");
    }
    case "typography":
      return null;
  }
}

function declarations(entries: readonly TokenEntry[], gamut: Gamut): Declaration[] {
  return entries.flatMap(({ path, token }) => {
    const value = cssValue(token, gamut);
    return value === null ? [] : [[cssName(path), value] as const];
  });
}

/** The declarations whose P3 value differs from their sRGB one. */
function p3Overrides(entries: readonly TokenEntry[]): Declaration[] {
  const srgb = new Map(declarations(entries, "srgb"));
  return declarations(entries, "p3").filter(([property, value]) => srgb.get(property) !== value);
}

function durationMs(token: DtcgToken): number | undefined {
  if (token.$type !== "duration" || isReference(token.$value)) return undefined;
  return token.$value.unit === "s" ? token.$value.value * 1000 : token.$value.value;
}

/** Under reduced motion, every duration longer than `duration.reduced` is capped to it. */
function reducedMotion(entries: readonly TokenEntry[]): Declaration[] {
  const durations = entries.filter(({ path }) => path[0] === "duration");
  const cap = durations.find(({ path }) => path[1] === "reduced");
  const capMs = cap && durationMs(cap.token);
  if (!cap || capMs === undefined) return [];
  return durations
    .filter(({ token }) => (durationMs(token) ?? 0) > capMs)
    .map(({ path }) => [cssName(path), `var(${cssName(cap.path)})`] as const);
}

function rule(
  selectors: readonly string[],
  body: readonly (Declaration | string)[],
  depth = 0,
): string | null {
  if (!body.some((line) => typeof line !== "string")) return null;
  const pad = "  ".repeat(depth);
  const lines = body.map(
    (line) => `${pad}  ${typeof line === "string" ? line : `${line[0]}: ${line[1]}`};`,
  );
  return `${pad}${selectors.join(`,\n${pad}`)} {\n${lines.join("\n")}\n${pad}}`;
}

function media(query: string, inner: string | null): string | null {
  return inner === null ? null : `@media ${query} {\n${inner}\n}`;
}

function describeInputs({ base, accent, contrast }: ThemeInputs): string {
  return `base ${base.hue},${base.chroma} · accent ${accent.l},${accent.c},${accent.h} · contrast ${contrast}`;
}

/** Reads the inputs both theme files were generated from, and checks that they agree. */
export function buildInputs(files: TokenFiles): ThemeInputs {
  if (themeModeOf(files.light) !== "light" || themeModeOf(files.dark) !== "dark") {
    throw new Error("light.tokens.json and dark.tokens.json must record their own mode");
  }
  const inputs = themeInputsOf(files.light);
  if (JSON.stringify(inputs) !== JSON.stringify(themeInputsOf(files.dark))) {
    throw new Error("the light and dark token files were generated from different inputs");
  }
  return inputs;
}

const LIGHT = [":root", '[data-theme="light"]'];
const DARK = ['[data-theme="dark"]'];
const AUTO_DARK = [':root:not([data-theme="light"])'];

/**
 * `:root` holds the shared tokens and the light theme, `[data-theme="dark"]` the dark theme,
 * and `prefers-color-scheme` picks dark unless the page asks for light. Wide-gamut colors get
 * P3 overrides right after each theme block, so the later sRGB theme blocks still win over an
 * earlier theme's P3 values.
 */
export function buildCss(files: TokenFiles): string {
  const inputs = buildInputs(files);
  const shared = SHARED_FILE_NAMES.flatMap((name) => flatten(files[name].tokens));
  const light = flatten(files.light.tokens);
  const dark = flatten(files.dark.tokens);
  const darkBody = ["color-scheme: dark", ...declarations(dark, "srgb")];
  const blocks = [
    `/*\n * Earshot design tokens, built by @earshot/tokens from packages/tokens/tokens. Don't edit.\n * Theme inputs: ${describeInputs(inputs)}.\n */`,
    rule([":root"], declarations(shared, "srgb")),
    rule(LIGHT, ["color-scheme: light", ...declarations(light, "srgb")]),
    media("(color-gamut: p3)", rule(LIGHT, p3Overrides(light), 1)),
    rule(DARK, darkBody),
    media("(color-gamut: p3)", rule(DARK, p3Overrides(dark), 1)),
    media("(prefers-color-scheme: dark)", rule(AUTO_DARK, darkBody, 1)),
    media(
      "(prefers-color-scheme: dark) and (color-gamut: p3)",
      rule(AUTO_DARK, p3Overrides(dark), 1),
    ),
    media("(prefers-reduced-motion: reduce)", rule([":root"], reducedMotion(shared), 1)),
  ];
  return `${blocks.filter((block) => block !== null).join("\n\n")}\n`;
}

/** Rewrites `{color.neutral.1}` to `{light.color.neutral.1}` for groups that moved under a theme. */
function underTheme<T>(node: T, theme: string, groups: ReadonlySet<string>): T {
  if (isReference(node)) {
    const [head = ""] = node.slice(1, -1).split(".");
    return (groups.has(head) ? `{${theme}.${node.slice(1)}` : node) as T;
  }
  if (Array.isArray(node)) return node.map((item) => underTheme(item, theme, groups)) as T;
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, underTheme(value, theme, groups)]),
    ) as T;
  }
  return node;
}

/** One DTCG document: `light` and `dark` groups plus the shared groups, references intact. */
export function buildJson(files: TokenFiles): string {
  const inputs = buildInputs(files);
  const document: Record<string, unknown> = {
    $description:
      "Earshot design tokens (DTCG 2025.10): the light and dark themes plus the shared tokens. Built by @earshot/tokens from packages/tokens/tokens. Don't edit.",
    $extensions: { earshot: { inputs } },
  };
  for (const mode of ["light", "dark"] as const) {
    const tokens = files[mode].tokens;
    document[mode] = underTheme(tokens, mode, new Set(Object.keys(tokens)));
  }
  for (const name of SHARED_FILE_NAMES) {
    for (const [group, node] of Object.entries(files[name].tokens)) {
      if (group in document) throw new Error(`token group "${group}" is defined twice`);
      document[group] = node;
    }
  }
  return `${formatJson(document)}\n`;
}
