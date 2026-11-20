import { expect, test } from "@playwright/test";
import { HOLD_MS, LINES, openFakeCapture, transcript, waitUntilReady } from "./support";

test.setTimeout(180_000);

test("the transcript announces finished lines only: partials stay out of the live region", async ({
  page,
}) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);

  const log = transcript(page);
  await expect(log).toHaveAttribute("aria-live", "polite");
  await expect(log).toHaveAttribute("aria-relevant", "additions");
  // Nothing else on the capture screen speaks on its own: the feed and the status aren't live.
  // (Outside it, the app's toaster, the clip player's status line, and Next's route announcer have
  // their own regions.)
  await expect(page.locator("main [aria-live]")).toHaveCount(1);

  // Record every node added to the live region while a line is said.
  await log.evaluate((element) => {
    const added: string[] = [];
    (window as unknown as { __announced: string[] }).__announced = added;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) added.push(node.textContent ?? "");
      }
    }).observe(element, { childList: true, subtree: true, characterData: true });
  });

  await page.keyboard.down("Space");
  // Mid-line: the partial shows, hidden from assistive tech, outside the log.
  const partial = page.locator("[data-slot=partial]");
  await expect(partial).toBeVisible({ timeout: 10_000 });
  await expect(partial).toHaveAttribute("aria-hidden", "true");
  expect(await log.locator("[data-slot=partial]").count()).toBe(0);
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.up("Space");

  await expect(log.locator("p")).toHaveText([LINES[0]], { timeout: 20_000 });
  await expect(partial).toBeHidden();
  const announced = await page.evaluate(
    () => (window as unknown as { __announced: string[] }).__announced,
  );
  // One addition, the finished line, whole.
  expect(announced).toEqual([LINES[0]]);
});
