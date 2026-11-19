import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openFakeCapture, proposalCards, sayWithSpace, waitUntilReady } from "./support";

test.setTimeout(180_000);

const SNAPSHOT = "capture-reduced-motion.png";

test("with reduced motion nothing moves: a still orb, cards that appear in place", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);

  const orb = page.getByRole("img", { name: "Microphone level" });
  await expect(orb).toHaveAttribute("data-renderer", "still");
  await expect(orb).toHaveAttribute("data-animating", "false");

  await sayWithSpace(page);
  await expect(proposalCards(page).first()).toBeVisible({ timeout: 20_000 });
  // No animation ran for the card, not even a View Transition's.
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => (animation as CSSAnimation).animationName ?? animation.id),
  );
  expect(running).toEqual([]);

  // End the session so the microphone level settles at zero: then the frame is deterministic.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(orb).toHaveAttribute("data-level", "0.00");

  // The pixel snapshot needs a baseline for this platform (fonts render differently on each). Make
  // one with `pnpm exec playwright test e2e/capture/reduced-motion.spec.ts --update-snapshots`.
  const baseline = testInfo.snapshotPath(SNAPSHOT);
  const recording = ["all", "changed"].includes(testInfo.config.updateSnapshots);
  if (!existsSync(baseline) && !recording) {
    testInfo.annotations.push({
      type: "skipped-snapshot",
      description: `No ${process.platform} baseline at ${baseline}; the motion checks above ran.`,
    });
    return;
  }
  await expect(page.getByRole("region", { name: "Capture controls" })).toHaveScreenshot(SNAPSHOT, {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});
