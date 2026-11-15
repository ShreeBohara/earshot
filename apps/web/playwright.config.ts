import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against a local server or a deployed preview (set BASE_URL).
export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "smoke", use: { ...devices["Desktop Chrome"] } }],
});
