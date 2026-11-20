import { expect, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import {
  LINES,
  openFakeCapture,
  proposalCards,
  sayWithSpace,
  tabTo,
  transcript,
  waitUntilReady,
} from "./support";

// next dev compiles each page on first visit, and each line is held in real time.
test.setTimeout(180_000);

for (const colorScheme of ["light", "dark"] as const) {
  test(`a whole debrief from the keyboard alone, and the screen passes axe (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    const start = await openFakeCapture(page);
    expect(await seriousViolations(page)).toEqual([]);

    // Reach Start with Tab, start with Enter: no pointer anywhere in this test.
    await tabTo(page, start);
    await page.keyboard.press("Enter");
    await waitUntilReady(page);

    // Line 1: a contact, "Dana Lee", who sounds like two in the CRM: the linker asks.
    await sayWithSpace(page);
    await expect(transcript(page).locator("p")).toHaveText([LINES[0]], { timeout: 20_000 });
    await expect(proposalCards(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Contact · Ask: Donna Lee or Dana Li?" }),
    ).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    // Line 2: nothing to propose, said so in the feed.
    await sayWithSpace(page);
    await expect(transcript(page).locator("p")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByText("Nothing to propose from that turn.")).toBeVisible({
      timeout: 20_000,
    });

    // Line 3: a deal update.
    await sayWithSpace(page);
    await expect(page.getByRole("heading", { name: /^Deal update · / })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-slot=cost]").first()).toContainText("Cost so far $");

    // `?` lists the shortcuts; Esc closes the dialog without ending the debrief.
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /End debrief/ })).toBeVisible();

    // `P` pauses live updates; `P` again resumes them.
    await page.keyboard.press("p");
    await expect(page.getByText("Live updates are paused; capture carries on.")).toBeVisible();
    await page.keyboard.press("p");
    await expect(page.getByText("Live updates are paused; capture carries on.")).toBeHidden();

    // Esc ends it, with the final cost.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/This debrief cost \$/).first()).toBeVisible();
    await expect(proposalCards(page)).toHaveCount(2);
  });
}
