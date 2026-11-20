import { expect, test } from "@playwright/test";
import { HOLD_MS, openFakeCapture, waitUntilReady } from "./support";

test.setTimeout(180_000);

/** The spec's target for press-to-feedback (WP9; the plan's 200 ms interaction budget). */
const BUDGET_MS = 200;

test("press-to-feedback stays under 200 ms, by PerformanceObserver", async ({ page }) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);

  // Event Timing reports slow input events (16 ms and up) from the event to the next paint; the
  // screen's own measure covers each press whatever its speed.
  await page.evaluate(() => {
    const seen: { kind: string; name: string; duration: number }[] = [];
    (window as unknown as { __timings: typeof seen }).__timings = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        seen.push({ kind: entry.entryType, name: entry.name, duration: entry.duration });
      }
    }).observe({
      type: "event",
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "earshot:ptt-feedback") {
          seen.push({ kind: entry.entryType, name: entry.name, duration: entry.duration });
        }
      }
    }).observe({ type: "measure" });
  });

  const button = page.getByRole("button", { name: "Push to talk" });
  // A press with the mouse.
  const box = await button.boundingBox();
  if (!box) throw new Error("no push-to-talk button");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  // And one with Space.
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.up("Space");

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __timings: { name: string }[] }).__timings.filter(
            (t) => t.name === "earshot:ptt-feedback",
          ).length,
      ),
    )
    .toBe(2);
  const timings = await page.evaluate(
    () =>
      (window as unknown as { __timings: { kind: string; name: string; duration: number }[] })
        .__timings,
  );
  const presses = timings.filter((t) => t.name === "earshot:ptt-feedback");
  const slowInputs = timings.filter(
    (t) => t.kind === "event" && ["pointerdown", "keydown", "pointerup", "keyup"].includes(t.name),
  );
  testInfo().annotations.push({
    type: "press-to-feedback",
    description: presses.map((p) => `${p.duration.toFixed(1)} ms`).join(", "),
  });
  for (const timing of [...presses, ...slowInputs]) {
    expect(timing.duration, `${timing.kind} ${timing.name}`).toBeLessThan(BUDGET_MS);
  }
});

function testInfo() {
  return test.info();
}
