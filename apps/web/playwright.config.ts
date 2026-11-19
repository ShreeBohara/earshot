import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against a deployed preview (set BASE_URL), or locally against `next dev` in its
// zero-setup mode (in-process PGlite, no secrets), which Playwright starts on port 3100. The
// health check in smoke.spec.ts needs a deployed stack; run e2e/sign-in.spec.ts and
// e2e/keys.spec.ts locally.
//
// e2e/capture/ drives the capture screen in its development-only fake mode: Chrome's fake
// microphone, the fake speech-to-text adapter, and the edge Worker's e2e entry, whose cassettes
// answer every turn (CONTRIBUTING.md). No keys, no provider calls. Playwright starts that Worker
// on port 8787 too, accepting sockets from this server's origin.
const LOCAL_PORT = 3100;
const LOCAL_ORIGIN = `http://localhost:${LOCAL_PORT}`;
const EDGE_PORT = 8787;
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  // One baseline per platform; e2e/capture/reduced-motion.spec.ts skips its pixel check where
  // there's none yet.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}",
  use: {
    baseURL: remote ?? `http://localhost:${LOCAL_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    // Matched on e2e/capture/ itself: the checkout's own path may contain "capture" too.
    {
      name: "smoke",
      testIgnore: /[\\/]e2e[\\/]capture[\\/]/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "capture",
      testMatch: /[\\/]e2e[\\/]capture[\\/][^\\/]+\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          // A synthetic microphone (a tone with pauses) instead of a device or a prompt.
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],
  ...(remote
    ? {}
    : {
        webServer: [
          {
            // The voice assets first (the capture worklet and the VAD files), as `pnpm dev` does.
            // The output is copied to .data/e2e/dev-server.log (gitignored), where
            // e2e/support/sign-in.ts finds the development-only magic links zero-setup mode
            // prints.
            command: `mkdir -p .data/e2e && pnpm exec earshot-voice-assets public && pnpm exec next dev --port ${LOCAL_PORT} 2>&1 | tee .data/e2e/dev-server.log`,
            url: `${LOCAL_ORIGIN}/sign-in`,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
            env: {
              // Magic links and Better Auth's origin check follow this server's port, not the
              // development default of 3000. Without a .dev.vars file, wrangler hands the process
              // environment to the app only when asked.
              BETTER_AUTH_URL: LOCAL_ORIGIN,
              CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
              EDGE_DEV_URL: `http://localhost:${EDGE_PORT}`,
            },
          },
          {
            // The edge Worker with cassette extraction (apps/edge/src/e2e.ts), which only answers
            // the e2e scenario route the fake mode checks for.
            command: `pnpm --dir ../edge exec wrangler dev src/e2e.ts --port ${EDGE_PORT} --var WEB_ORIGIN:${LOCAL_ORIGIN}`,
            url: `http://localhost:${EDGE_PORT}/v1/e2e/scenario`,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ],
      }),
});
