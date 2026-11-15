import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots Postgres in WebAssembly, which takes a few seconds per database.
    testTimeout: 30_000,
  },
});
