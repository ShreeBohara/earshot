import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against a deployed preview (set BASE_URL), or locally against `next dev` in its
// zero-setup mode (in-process PGlite, no secrets), which Playwright starts on port 3100. The
// health check in smoke.spec.ts needs a deployed stack; run e2e/sign-in.spec.ts locally.
const LOCAL_PORT = 3100;
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: remote ?? `http://localhost:${LOCAL_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "smoke", use: { ...devices["Desktop Chrome"] } }],
  ...(remote
    ? {}
    : {
        webServer: {
          command: `pnpm exec next dev --port ${LOCAL_PORT}`,
          url: `http://localhost:${LOCAL_PORT}/sign-in`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
});
