import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots Postgres in WebAssembly, which takes a few seconds per database, and longer
    // when turbo runs every package's tests and builds at once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
