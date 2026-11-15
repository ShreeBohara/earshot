// Regenerates tokens/*.tokens.json from the three theme inputs and prints a short summary:
//   pnpm --filter @earshot/tokens theme --base 85,0.01 --accent 0.30,0.03,265 --contrast 50
import { parseArgs } from "node:util";
import {
  type ContrastResult,
  checkContrast,
  DEFAULT_INPUTS,
  generateTheme,
  isWideGamut,
  MODES,
  RAMP_NAMES,
  STATE_NAMES,
  type ThemeInputs,
  type ThemeMode,
  TOKEN_FILE_NAMES,
  tokenFiles,
} from "../src";
import { writeTokenFiles } from "./files";

const USAGE = `Usage: pnpm --filter @earshot/tokens theme [--base H,C] [--accent L,C,H] [--contrast N]

  --base      hue and peak chroma of the neutrals          default 85,0.01 (warm paper)
  --accent    the brand color, in OKLCH                     default 0.30,0.03,265 (blue-black ink)
  --contrast  0-100: how far text and borders sit from bg   default 50`;

function parseNumbers<const Names extends readonly string[]>(
  flag: string,
  raw: string,
  names: Names,
): Record<Names[number], number> {
  const parts = raw.split(",").map((part) => part.trim());
  if (
    parts.length !== names.length ||
    parts.some((part) => part === "" || !Number.isFinite(Number(part)))
  ) {
    throw new Error(
      `--${flag} takes ${names.length} comma-separated numbers (${names.join(",")}), got "${raw}"`,
    );
  }
  return Object.fromEntries(names.map((name, i) => [name, Number(parts[i])])) as Record<
    Names[number],
    number
  >;
}

function readInputs(args: string[]): ThemeInputs | undefined {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: "string" },
      accent: { type: "string" },
      contrast: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return undefined;
  return {
    base: values.base ? parseNumbers("base", values.base, ["hue", "chroma"]) : DEFAULT_INPUTS.base,
    accent: values.accent
      ? parseNumbers("accent", values.accent, ["l", "c", "h"])
      : DEFAULT_INPUTS.accent,
    contrast: values.contrast
      ? parseNumbers("contrast", values.contrast, ["value"]).value
      : DEFAULT_INPUTS.contrast,
  };
}

const GROUPS: readonly { label: string; test: (result: ContrastResult) => boolean }[] = [
  { label: "text", test: (r) => r.fg === "text" || r.fg === "text-muted" },
  { label: "on-accent", test: (r) => r.fg === "on-accent" },
  { label: "state text", test: (r) => r.min === 4.5 && r.fg.startsWith("state-") },
  { label: "non-text", test: (r) => r.min === 3 },
];

function contrastLine(results: readonly ContrastResult[]): string {
  return GROUPS.map(({ label, test }) => {
    const worst = results
      .filter(test)
      .reduce((a, b) => (Math.min(a.srgb, a.p3) <= Math.min(b.srgb, b.p3) ? a : b));
    const ratio = Math.min(worst.srgb, worst.p3).toFixed(2);
    return worst.min === 3
      ? `${label} ${ratio}`
      : `${label} ${ratio} (Lc ${Math.abs(worst.apca).toFixed(0)})`;
  }).join(" · ");
}

function wideGamutCount(theme: ThemeMode): number {
  return RAMP_NAMES.flatMap((ramp) => theme.ramps[ramp]).filter((s) => isWideGamut(s.oklch)).length;
}

function main(): void {
  const inputs = readInputs(process.argv.slice(2));
  if (!inputs) {
    console.log(USAGE);
    return;
  }
  const theme = generateTheme(inputs);
  writeTokenFiles(tokenFiles(theme));

  const { base, accent, contrast } = theme.inputs;
  const columns = ["bg", "text", "accent", "on-accent", ...STATE_NAMES] as const;
  const swatches = (mode: ThemeMode) =>
    columns.map((column) =>
      (column === "bg" || column === "text" || column === "accent" || column === "on-accent"
        ? mode.semantic[column]
        : mode.semantic[`state-${column}-solid`]
      ).hex.padEnd(10),
    );
  const results = { light: checkContrast(theme.light), dark: checkContrast(theme.dark) };
  const failures = MODES.flatMap((mode) =>
    results[mode].filter((r) => !r.pass).map((r) => ({ mode, ...r })),
  );

  console.log(
    `Wrote ${TOKEN_FILE_NAMES.length} files to packages/tokens/tokens from base ${base.hue},${base.chroma} · accent ${accent.l},${accent.c},${accent.h} · contrast ${contrast}\n`,
  );
  console.log(`         ${columns.map((c) => c.padEnd(10)).join("")}`);
  for (const mode of MODES) console.log(`  ${mode.padEnd(7)}${swatches(theme[mode]).join("")}`);
  console.log("\nLowest WCAG 2.1 contrast per group, sRGB or P3 (APCA Lc for information):");
  for (const mode of MODES) console.log(`  ${mode.padEnd(7)}${contrastLine(results[mode])}`);
  console.log(
    `\nP3 screens get wider-gamut values for ${wideGamutCount(theme.light)} light and ${wideGamutCount(theme.dark)} dark colors.`,
  );
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(
        `FAIL ${f.mode}: ${f.fg} on ${f.bg} is ${Math.min(f.srgb, f.p3).toFixed(2)}:1, needs ${f.min}:1`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const checks = results.light.length + results.dark.length;
  console.log(`All ${checks} contrast checks pass. Next: pnpm --filter @earshot/tokens build`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${USAGE}`);
  process.exitCode = 1;
}
