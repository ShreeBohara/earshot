import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against a deployed preview (set BASE_URL), or locally against `next dev` in its
// zero-setup mode (in-process PGlite, no secrets), which Playwright starts on port 3100. The
// health check in smoke.spec.ts needs a deployed stack; run e2e/sign-in.spec.ts and
// e2e/keys.spec.ts locally.
const LOCAL_PORT = 3100;
const LOCAL_ORIGIN = `http://localhost:${LOCAL_PORT}`;
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
          // The output is copied to .data/e2e/dev-server.log (gitignored), where
          // e2e/support/sign-in.ts finds the development-only magic links zero-setup mode prints.
          command: `mkdir -p .data/e2e && pnpm exec next dev --port ${LOCAL_PORT} 2>&1 | tee .data/e2e/dev-server.log`,
          url: `${LOCAL_ORIGIN}/sign-in`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: {
            // Magic links and Better Auth's origin check follow this server's port, not the
            // development default of 3000. Without a .dev.vars file, wrangler hands the process
            // environment to the app only when asked.
            BETTER_AUTH_URL: LOCAL_ORIGIN,
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
          },
        },
      }),
});
