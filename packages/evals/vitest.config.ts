import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The linking tests regenerate the confusable-name set and fit linker v1 several times. Each
    // takes well under a second alone, and many times that when turbo runs every package's tests
    // at once, which is where the default 5 s ran out.
    testTimeout: 30_000,
  },
});
