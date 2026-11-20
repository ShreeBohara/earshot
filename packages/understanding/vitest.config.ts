import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The parity test boots Postgres in WebAssembly (PGlite) and the bundle test runs esbuild,
    // which take a few seconds each, and longer when turbo runs every package at once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
