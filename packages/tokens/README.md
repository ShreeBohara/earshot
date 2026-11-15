# @earshot/tokens

Earshot's design tokens. A generator turns three inputs into a light and a dark theme that pass WCAG contrast checks, writes them as [DTCG 2025.10](https://www.designtokens.org/) token files, and a build turns those into `tokens.css` and `tokens.json`.

The default theme is warm paper with blue-black ink. Buttons are ink on paper in the light theme and paper on ink in the dark theme, so color is left for meaning: blue for proposed, amber for conflict, green for synced, red for failed.

## The three inputs

| Input | Meaning | Default |
|---|---|---|
| `base` | Hue and peak chroma of the neutral colors | `85,0.01`: warm paper |
| `accent` | The brand color, as OKLCH lightness, chroma, and hue | `0.30,0.03,265`: blue-black ink |
| `contrast` | 0–100: how far text and borders sit from their backgrounds | `50` |

`contrast` moves border steps 6–8 by up to ±0.04 and text steps 11–12 by up to ±0.06 in lightness, away from the background (above 50) or toward it (below 50).

## Regenerating a theme

```sh
pnpm --filter @earshot/tokens theme --base 85,0.01 --accent 0.30,0.03,265 --contrast 50
pnpm --filter @earshot/tokens generate
```

`theme` rewrites `tokens/*.tokens.json` and prints the key colors and the lowest contrast ratio per group. It exits with an error if any pair misses its minimum. Any flag you leave out takes its default. Commit the token files: they're the source the build reads, and a test fails if they no longer match a fresh run of the generator with the inputs they record.

`theme` also runs `generate`, which writes `generated/tokens.css` and `generated/tokens.json`. Both are committed, so consumers need no build step, and a test fails if they no longer match the token files. The package exports:

- `@earshot/tokens/tokens.css`: the custom properties below.
- `@earshot/tokens/tokens.json`: one DTCG document with `light` and `dark` groups plus the shared tokens, with references intact.
- `@earshot/tokens`: the TypeScript API (`generateTheme`, `tokenFiles`, `buildCss`, `checkContrast`, the typed hand-written tokens). It has no Node imports, so it runs in the browser, for example in a live theme playground.

## How a theme is built

Every ramp has 12 steps, each with a fixed job:

| Steps | Job |
|---|---|
| 1–2 | Backgrounds |
| 3–5 | Component fills: rest, hover, pressed |
| 6–8 | Borders: subtle, default, strong or focus |
| 9–10 | Solid fills |
| 11–12 | Text: muted, default |

There are six ramps: `neutral`, `accent`, and one per state (`proposed` at hue 250, `conflict` at 75, `synced` at 150, `failed` at 25).

1. **Lightness.** All ramps in a mode share one curve, tuned from the spec's starting values until the contrast tests pass. The final values, with the reasons, are in `src/generate.ts`:
   - light: 0.985 0.970 0.945 0.920 0.895 0.845 0.720 0.600 0.540 0.500 0.420 0.230
   - dark: 0.150 0.180 0.215 0.245 0.275 0.325 0.440 0.555 0.620 0.660 0.800 0.950
2. **Chroma.** Neutrals scale `base` chroma by a curve that peaks mid-ramp. The accent and the states use their own chroma (0.16 for states), full on the solids and tapered at both ends.
3. **Accent solids.** Steps 9–10 of the accent ramp are pinned to the accent's own lightness, then nudged just far enough for `on-accent` to reach 4.5:1. In the dark theme, the lightness becomes max(L, 1.25 − L), so ink at 0.30 becomes paper at 0.95.
4. **A guard on step 8.** `border-strong` and `focus-ring` must reach 3:1. The curve gets there for the tested inputs; for others, such as a luminous green accent on heavily tinted neutrals, step 8 moves further from the background until it does.
5. **Gamut.** Every color is gamut-mapped with the CSS Color 4 algorithm (colorjs.io): into Display P3 for the DTCG `components`, and into sRGB for the `hex` fallback. Colors outside sRGB get `color(display-p3 …)` overrides under `@media (color-gamut: p3)`.

## Semantic tokens

Components use these, never the ramp steps directly. Each is a CSS variable (`--es-bg`) and a DTCG alias (`{semantic.bg}`).

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | neutral 1 | neutral 1 | Page background |
| `bg-subtle` | neutral 2 | neutral 2 | Sidebars, table stripes, code blocks |
| `surface` | neutral 1 | neutral 2 | Cards and panels |
| `surface-raised` | neutral 1 | neutral 3 | Popovers, menus, dialogs, toasts |
| `border` | neutral 6 | neutral 6 | Hairlines: card edges, dividers |
| `border-strong` | neutral 8 | neutral 8 | Input borders, component edges (3:1 on `bg`) |
| `text` | neutral 12 | neutral 12 | Body text |
| `text-muted` | neutral 11 | neutral 11 | Secondary text (4.5:1 on every surface) |
| `accent` | accent 9 | accent 9 | Primary actions |
| `accent-hover` | accent 10 | accent 10 | Hover on primary actions |
| `on-accent` | neutral 1 or 12 | neutral 1 or 12 | Text on `accent` (4.5:1) |
| `focus-ring` | accent 8 | accent 8 | Focus rings (3:1 on `bg`) |
| `state-{proposed,conflict,synced,failed}-bg` | state 3 | state 3 | Soft state background |
| `state-…-border` | state 7 | state 7 | State border |
| `state-…-text` | state 11 | state 11 | Text on the state background (4.5:1) |
| `state-…-solid` | state 9 | state 9 | Dots, icons, strong pills (3:1 on `bg`) |

Light surfaces stay on paper and rise with shadows; dark surfaces rise by getting lighter. Dark-theme solids (L 0.62) read better with dark text than with white.

### shadcn/ui aliases

Stock shadcn components work unchanged. Watch one name: shadcn's `--accent` is a subtle hover fill, so it maps to neutral step 4. Earshot's accent is `--primary`.

| Variable | Points at |
|---|---|
| `--background`, `--foreground` | `bg`, `text` |
| `--card`, `--card-foreground` | `surface`, `text` |
| `--popover`, `--popover-foreground` | `surface-raised`, `text` |
| `--primary`, `--primary-foreground` | `accent`, `on-accent` |
| `--secondary`, `--secondary-foreground` | neutral 3, `text` |
| `--muted`, `--muted-foreground` | neutral 3, `text-muted` |
| `--accent`, `--accent-foreground` | neutral 4, `text` |
| `--destructive` | `state-failed-solid` |
| `--border`, `--input`, `--ring` | `border`, `border-strong`, `focus-ring` |

## Everything in tokens.css

| Variables | From |
|---|---|
| `--es-{neutral,accent,proposed,conflict,synced,failed}-{1…12}` | The ramps |
| `--es-<semantic name>`, `--<shadcn name>` | The tables above |
| `--es-elevation-{1,2}` | Two shadows in light; a hairline border and a faint inner highlight in dark |
| `--es-font-{serif,sans,mono}` | Instrument Serif (display, 30px and up), Geist (interface), Geist Mono (data and evidence; use `tabular-nums`) |
| `--es-font-weight-{regular,medium,semibold}` | 400, 500, 600 |
| `--es-font-size-N`, `--es-font-line-height-N` | 12/16, 13/18, 14/20 (body), 16/24, 18/26, 20/28, 24/32, 30/36, 36/40, 48/52, 60/64 |
| `--es-font-tracking-{30,36,48,60}` | −0.01em at 30px to −0.02em at 60px, in px |
| `--es-space-N` | A 4px grid: `N × 4px` |
| `--es-radius-{sm,md,lg,xl,full}` | 4, 6, 10, 14, 9999px |
| `--es-duration-{fast,medium,slow}`, `--es-easing-{standard,exit}` | 120/180/240ms; `cubic-bezier(0.2, 0, 0, 1)` and `cubic-bezier(0.4, 0, 1, 1)` |
| `--es-size-control-{sm,md,lg}`, `--es-size-target-min` | 32, 36, 44px (touch); 24px minimum target |

The light theme sits on `:root` and `[data-theme="light"]`, the dark theme on `[data-theme="dark"]`, and `@media (prefers-color-scheme: dark)` applies dark to `:root:not([data-theme="light"])`. Either theme can be set on any element, so a page can show both side by side. Under `prefers-reduced-motion`, every duration is capped at `--es-duration-reduced` (120ms), and animations should become opacity fades.

The DTCG typography composites (`type.12` to `type.60`) are in the token files and `tokens.json`; CSS gets their parts, since one custom property can't hold a whole text style.

## Why not Style Dictionary

The spec suggested Style Dictionary 5.8. It reads top-level DTCG 2025.10 color objects correctly, falling back to `hex` when a color is outside sRGB, but the rest didn't fit:

- Colors nested in composite tokens, like shadow colors, come out as raw `oklch()` strings, with no gamut mapping and no hex fallback.
- Typography composites become the `font` shorthand and drop `letterSpacing`.
- The output needs theme blocks, a `prefers-color-scheme` block, P3 overrides for only the out-of-gamut colors, and unprefixed shadcn names. Each needs a custom format, transform, or name hook.

That's the whole builder written as plugins, plus Style Dictionary's dependencies (Prettier, chalk, tinycolor2, and a second colorjs.io). `src/css.ts` does the same job in about 250 lines, and its output is byte-for-byte deterministic.

## Tests

`pnpm --filter @earshot/tokens test` runs Vitest:

- **Contrast**: every pair from the spec, in both themes, for the default inputs, a saturated orange accent at contrast 0, and a cool base at contrast 100. Ratios are WCAG 2.1, computed with colorjs.io on the hex values and again with the P3 overrides applied. APCA Lc is attached to each test for information.
- **Gamut**: every sRGB value in `tokens.css` is in gamut, every P3 override is inside P3 and outside sRGB, and every `hex` is the CSS Color 4 mapping of its `components`.
- **Determinism**: the same inputs give byte-identical CSS, token files, and JSON, and the committed token files match a fresh run.
- **Behavior**: the contrast slider, ramp order, state hues, the accent solver, the step 8 guard, the shadcn mapping, and the CSS structure.
