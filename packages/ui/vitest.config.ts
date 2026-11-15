import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Every story is a test: it must render, pass its play function, and pass axe
// (`a11y: { test: "error" }` in .storybook/preview.ts). Run with `pnpm test:storybook`.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          storybookTest({ configDir: fileURLToPath(new URL(".storybook", import.meta.url)) }),
        ],
        test: {
          name: "storybook",
          setupFiles: ["./.storybook/vitest.setup.ts"],
          // Base UI's toast stack measures itself with a ResizeObserver, and Chromium reports the
          // harmless "loop completed with undelivered notifications" warning as an error.
          onUnhandledError: (error) => !error.message?.includes("ResizeObserver loop"),
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
