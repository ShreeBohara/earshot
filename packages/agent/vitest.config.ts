import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { parse } from "jsonc-parser";
import { defineConfig } from "vitest/config";

// The workerd project runs with the edge Worker's compatibility date and flags, read from its
// wrangler.jsonc, because SessionDO is where the extractor runs in production.
const edge = parse(
  readFileSync(new URL("../../apps/edge/wrangler.jsonc", import.meta.url), "utf8"),
) as { compatibility_date: string; compatibility_flags?: string[] };

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/workerd/**"] },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: edge.compatibility_date,
              compatibilityFlags: edge.compatibility_flags ?? [],
            },
          }),
        ],
        test: { name: "workerd", include: ["test/workerd/**/*.test.ts"] },
      },
    ],
  },
});
