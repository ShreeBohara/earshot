import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Integration tests: Better Auth's real handler over PGlite with every migration applied, so they
// need no database server or network.
export default defineConfig({
  resolve: {
    alias: {
      "@": here("."),
      // `server-only` throws outside React Server Components; tests import server modules directly.
      "server-only": here("./test/support/server-only.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // PGlite boots Postgres in WebAssembly, which takes a few seconds per database.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
