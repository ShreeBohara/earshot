import { expect, test } from "@playwright/test";
import {
  LINES,
  openFakeCapture,
  proposalCards,
  sayWithPointer,
  sayWithSpace,
  transcript,
  waitUntilReady,
} from "./support";

test.setTimeout(180_000);

test("the docked mini-session keeps a debrief going across pages, on desktop", async ({ page }) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);
  await sayWithSpace(page);
  await expect(proposalCards(page)).toHaveCount(1, { timeout: 20_000 });

  // A full page load would end the session; following links must not cause one.
  await page.evaluate(() => {
    (window as unknown as { __samePage: boolean }).__samePage = true;
  });
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
  const dock = page.getByRole("complementary", { name: "Debrief in progress" });
  await expect(dock).toBeVisible();
  await expect(dock).toContainText(LINES[0]);
  await expect(dock).toContainText("1 proposal");

  // Talk from the dock: with its button, then with Space.
  await sayWithPointer(page, dock.getByRole("button", { name: "Push to talk" }));
  await expect(dock).toContainText(LINES[1], { timeout: 20_000 });
  await sayWithSpace(page);
  await expect(dock).toContainText(LINES[2], { timeout: 20_000 });
  await expect(dock).toContainText("2 proposals", { timeout: 20_000 });

  // Back to the full screen: the same session, with everything said while docked.
  await dock.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/capture$/);
  await expect(dock).toBeHidden();
  await expect(transcript(page).locator("p")).toHaveText([...LINES]);
  await expect(proposalCards(page)).toHaveCount(2);
  expect(
    await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage),
  ).toBe(true);

  await page.getByRole("button", { name: /End debrief/ }).click();
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 20_000,
  });
});
