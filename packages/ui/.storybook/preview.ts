import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "../src/styles/globals.css";
import "./preview.css";

import type { Decorator, Preview } from "@storybook/react-vite";
import { createElement } from "react";

type Theme = "light" | "dark";

/** Puts the toolbar's theme on <html>, where the web app's next-themes puts it. */
const withTheme: Decorator = (Story, { globals }) => {
  const theme: Theme = globals.theme === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  return createElement(Story);
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color theme (sets data-theme on <html>)",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [withTheme],
  parameters: {
    layout: "centered",
    // Snapshot popups after their enter animation, not at its first (transparent) frame.
    chromatic: { pauseAnimationAtEnd: true },
    a11y: {
      // Fail the Vitest run on axe violations. The default, "todo", only warns, and prints
      // nothing in CI.
      test: "error",
      // Also check WCAG 2.5.8's 24×24px minimum target size, which axe leaves off by default.
      config: { rules: [{ id: "target-size", enabled: true }] },
    },
  },
};

export default preview;
