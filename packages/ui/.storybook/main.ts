import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { mergeConfig, type UserConfig } from "vite";

const src = fileURLToPath(new URL("../src", import.meta.url));
const web = fileURLToPath(new URL("../../../apps/web/", import.meta.url));

// Merged into Storybook's Vite config. The Vitest addon reuses it too, so the stories it tests
// get the same Tailwind build.
const vite: UserConfig = {
  plugins: [tailwindcss()],
  resolve: {
    // Components import each other through the package's own exports
    // (`@earshot/ui/components/button`); Vite doesn't resolve a package's self-references.
    alias: [
      { find: /^@earshot\/ui\/(components|hooks|lib)\//, replacement: `${src}/$1/` },
      // The web app's own components import each other as `@/…` (apps/web/tsconfig.json).
      { find: /^@\//, replacement: web },
    ],
  },
  // The web app's tsconfig says `jsx: preserve`, because Next compiles JSX itself. Vite would
  // honour that for the web app's stories and leave their JSX untransformed.
  oxc: { jsx: { runtime: "automatic" } },
  optimizeDeps: {
    // Pre-bundle every Base UI entry point up front. Found mid-run instead, they make Vite
    // reload the page, which fails the first Vitest run on a cold cache (every CI run).
    include: ["@base-ui/react/*"],
  },
  build: {
    rolldownOptions: {
      // Base UI marks its modules "use client" for React Server Components. The directive means
      // nothing in this bundle, and the warning prints once per module.
      onwarn: (warning, warn) => {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
};

const config: StorybookConfig = {
  // The library's components, and the web app's presentational components that have stories.
  stories: ["../src/**/*.stories.@(ts|tsx)", "../../../apps/web/components/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  // The theme toolbar (preview.ts) replaces the backgrounds tool: themes set the background.
  features: { backgrounds: false },
  viteFinal: (viteConfig) => mergeConfig(viteConfig, vite),
};

export default config;
