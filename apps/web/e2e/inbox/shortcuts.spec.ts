import { expect, test } from "@playwright/test";
import {
  CARDS,
  card,
  cards,
  expectFocusOffBody,
  focusCard,
  focused,
  openInboxWithSamples,
  reviewsSent,
} from "./support";

// The single-key shortcuts act only while focus is in the inbox's list, never from a text field,
// and not at all with Settings → Review's switch off (Phase 5 spec decision 7; WCAG 2.2 SC 2.1.4).
test.setTimeout(180_000);

/** Presses every shortcut once. */
async function pressEveryKey(page: import("@playwright/test").Page): Promise<void> {
  for (const key of ["j", "k", "a", "e", "r", "s", "c", "u", "1", "2", "3"]) {
    await page.keyboard.press(key);
  }
}

test("no shortcut acts outside the list or from a text field", async ({ page }) => {
  await openInboxWithSamples(page);

  // Outside the list: the page's own button, then the header's links.
  const help = page.getByRole("button", { name: "Keyboard shortcuts" });
  await help.focus();
  await pressEveryKey(page);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(7);
  await expect(help).toBeFocused();
  await page.getByRole("link", { name: "Capture" }).focus();
  await pressEveryKey(page);
  await expect(cards(page)).toHaveCount(7);

  // In the list, ? opens the help, and Esc closes it back onto the card.
  await focusCard(page, CARDS.pierTask);
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Inbox keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("NVDA+Space");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);

  // In a text field: e opens the editor, and the letters are typed, not run.
  await page.keyboard.press("e");
  const title = card(page, CARDS.pierTask).getByLabel("Title", { exact: true });
  await expect(title).toBeFocused();
  await title.press("End");
  await page.keyboard.type(" jkaersu 123");
  await expect(title).toHaveValue("Book a call with their operations team jkaersu 123");
  await expect(cards(page)).toHaveCount(7);
  // Esc cancels, and focus returns to the card, unchanged.
  await page.keyboard.press("Escape");
  await expect(title).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);
  await expect(card(page, CARDS.pierTask)).toContainText("Book a call with their operations team");

  // A stray digit on a linked card changes nothing: other records live in the correction panel.
  await page.keyboard.press("2");
  await expect(cards(page)).toHaveCount(7);
  await page.keyboard.press("c");
  const panel = card(page, CARDS.pierTask).getByRole("group", { name: "Correct the record" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);
  await expectFocusOffBody(page);
  await expect(page.locator("[data-inbox]")).toHaveAttribute("data-sending", "0");
});

test("with the switch off in Settings → Review, no single key acts, and the buttons still do", async ({
  page,
}) => {
  await openInboxWithSamples(page);
  await page.goto("/settings/review");
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Single-key shortcuts" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Saved on this device: shortcuts off.")).toBeVisible();

  await page.goto("/inbox");
  await expect(cards(page)).toHaveCount(7);
  // The keys are gone from the buttons, and so are their aria-keyshortcuts.
  const accept = card(page, CARDS.pierAmount).getByRole("button", { name: "Accept" });
  await expect(accept).not.toHaveAttribute("aria-keyshortcuts");
  await focusCard(page, CARDS.dana);
  await pressEveryKey(page);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(7);
  await expect.poll(() => focused(page)).toBe(CARDS.dana);

  // Every action is still a button.
  await accept.click();
  await expect(card(page, CARDS.pierAmount)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText(
    "Accepted: deal update for Pier Logistics - Expansion. 6 left.",
  );
  await expect(page.getByRole("region", { name: "Notifications" })).not.toContainText("Press U");
  await expectFocusOffBody(page);
  await reviewsSent(page);
});
