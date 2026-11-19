// Stories that render in both themes at once, so one axe run checks the light and the dark theme
// (spec WP9: "stories with axe, in both themes"). Tokens are scoped by `data-theme`, so each panel
// carries its own. Stories only: nothing in the app imports this.
import type { Decorator } from "@storybook/react-vite";
import { createElement } from "react";

export const STORY_THEMES = ["light", "dark"] as const;
export type StoryTheme = (typeof STORY_THEMES)[number];

/**
 * Renders the story twice, side by side: once per theme. The two panels repeat every landmark by
 * construction, so axe's landmark-unique rule is off for these stories (`bothThemesParameters`);
 * every other rule, contrast included, runs on both panels.
 */
export const bothThemes: Decorator = (Story) =>
  createElement(
    "div",
    { className: "grid w-full gap-4 lg:grid-cols-2" },
    STORY_THEMES.map((theme) =>
      createElement(
        "section",
        {
          key: theme,
          "data-theme": theme,
          "data-story-theme": theme,
          "aria-label": `${theme} theme`,
          className: "min-w-0 rounded-xl bg-background p-6 text-foreground ring-1 ring-border",
        },
        createElement(Story),
      ),
    ),
  );

/**
 * Parameters for a meta that uses `bothThemes`. Storybook replaces arrays when it merges
 * parameters, so this repeats preview.ts's rule list (target-size on) and adds the one exception.
 */
export const bothThemesParameters = {
  a11y: {
    test: "error",
    config: {
      rules: [
        { id: "target-size", enabled: true },
        { id: "landmark-unique", enabled: false },
      ],
    },
  },
} as const;

/** One theme's panel, for play functions: `within(themePanel(canvasElement))`. */
export function themePanel(root: HTMLElement, theme: StoryTheme = "light"): HTMLElement {
  const panel = root.querySelector<HTMLElement>(`[data-story-theme="${theme}"]`);
  if (!panel) throw new Error(`no ${theme} panel: is the story decorated with bothThemes?`);
  return panel;
}
