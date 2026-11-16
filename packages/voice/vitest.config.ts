import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two projects:
// - `unit` (`pnpm test`): Node, with fake sockets, a fake capture source, and fake timers. No
//   browser and no network, so it runs in CI's `checks` job.
// - `browser` (`pnpm test:browser`): Chromium through Playwright, for what only a browser has:
//   the AudioWorklet, getUserMedia (Chrome's fake microphone), and the Debrief engine end to end
//   against the fake adapter. CI runs it in the `ui` job, which installs Chromium.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/browser/**"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          testTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                args: [
                  "--use-fake-device-for-media-stream",
                  "--use-fake-ui-for-media-stream",
                  "--autoplay-policy=no-user-gesture-required",
                ],
              },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
