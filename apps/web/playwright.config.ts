import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against a deployed preview (set BASE_URL), or locally against `next dev` in its
// zero-setup mode (in-process PGlite, no secrets), which Playwright starts on port 3100. The
// health check in smoke.spec.ts needs a deployed stack; run e2e/sign-in.spec.ts, e2e/demo.spec.ts
// (the /demo replay, at the test-only 8×), and e2e/keys.spec.ts locally.
//
// e2e/inbox/ is the review inbox (Phase 5 WP5) over the test debriefs Settings → Data loads under
// next dev: keyboard, focus, and axe in every state. Like the capture tests, it needs next dev.
//
// e2e/pilot/ is the pilot page (Phase 5 WP7): consent first, a participant's run by keyboard to
// the download, the results file's fields, axe, and a network check that the page requests
// nothing but static files; and "Load sample debriefs" bringing pilot.v1 into the inbox. Its
// scripted reviewer (WP8, gates G1a and G2a) is the `reviewer` project: /pilot?p=ci by keyboard on
// a fake clock with the manifest's right answers, every card's markers, keys per decision, focus,
// axe in every state it reaches, and the KLM estimate per card against
// packages/evals/baselines/pilot-klm.json (EARSHOT_PILOT_KLM=record records it, on purpose).
//
// e2e/capture/ drives the capture screen in its development-only fake mode: Chrome's fake
// microphone, the fake speech-to-text adapter, and the edge Worker's e2e entry, whose cassettes
// answer every turn (CONTRIBUTING.md). No keys, no provider calls. Playwright starts that Worker
// on port 8787 too, accepting sockets from this server's origin.
//
// e2e/eval/ is the fake-microphone eval (spec WP11; docs/adr/0026): the 30 debrief WAVs through
// the same fake mode, one browser per WAV, so it launches its own browsers. `capture-smoke` runs
// first and `capture-eval` only if it passes. The WAVs come from lab/scripts/render_debriefs.py
// (EARSHOT_EVAL_WAVS; CONTRIBUTING.md). EARSHOT_EVAL_MODE=live runs the eval on real providers:
// the production edge entry instead of the e2e one, and keys from the environment (e2e/eval/live.ts).
const LOCAL_PORT = 3100;
const LOCAL_ORIGIN = `http://localhost:${LOCAL_PORT}`;
const EDGE_PORT = 8787;
const remote = process.env.BASE_URL;
const live = process.env.EARSHOT_EVAL_MODE === "live";

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  // The eval reporter writes the eval's results as one report, and does nothing in other runs.
  reporter: [
    ...(process.env.CI ? ([["github"]] as const) : []),
    ["list"],
    ["./e2e/eval/reporter.ts"],
  ],
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
      testIgnore: /[\\/]e2e[\\/](?:capture|eval|inbox|pilot)[\\/]/,
      use: { ...devices["Desktop Chrome"] },
    },
    // e2e/inbox/ reviews the test debriefs in the inbox (Phase 5 WP5): keys, focus, and axe in
    // every state, on the zero-setup server with no keys and no providers.
    {
      name: "inbox",
      testMatch: /[\\/]e2e[\\/]inbox[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    // e2e/pilot/ runs /pilot as a participant would, keyboard first, and checks it calls no server
    // (Phase 5 WP7).
    {
      name: "pilot",
      testMatch: /[\\/]e2e[\\/]pilot[\\/][^\\/]+\.spec\.ts$/,
      testIgnore: /[\\/]e2e[\\/]pilot[\\/]scripted-reviewer\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], acceptDownloads: true },
    },
    // The scripted reviewer (Phase 5 WP8): the pilot's path in CI at $0, so later packages can't
    // make cards slower, keys more numerous, or markers invisible.
    {
      name: "reviewer",
      testMatch: /[\\/]e2e[\\/]pilot[\\/]scripted-reviewer\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], acceptDownloads: true },
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
    // The eval's tests launch a browser each, with their own WAV; these projects only pick the
    // files. One test per script, sharded test by test (fullyParallel); run them with --workers=1
    // so the WAVs play one at a time and latency isn't measured on a contended machine.
    {
      name: "capture-smoke",
      testMatch: /[\\/]e2e[\\/]eval[\\/]capture-smoke\.spec\.ts$/,
    },
    {
      name: "capture-eval",
      testMatch: /[\\/]e2e[\\/]eval[\\/]capture-eval\.spec\.ts$/,
      fullyParallel: true,
      // Live runs have no e2e Worker for the smoke test's fake mode; their results carry the
      // same audio probes.
      dependencies: live ? [] : ["capture-smoke"],
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
            // the e2e scenario route the fake mode checks for; the production entry for live runs.
            command: `pnpm --dir ../edge exec wrangler dev ${live ? "src/index.ts" : "src/e2e.ts"} --port ${EDGE_PORT} --var WEB_ORIGIN:${LOCAL_ORIGIN}`,
            url: `http://localhost:${EDGE_PORT}${live ? "/health" : "/v1/e2e/scenario"}`,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ],
      }),
});
