import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import {
  CARDS,
  card,
  cards,
  focusCard,
  focused,
  openEmptyInbox,
  openInboxWithSamples,
  reviewsSent,
  settled,
} from "./support";

// axe (WCAG 2.2 AA tags, serious and critical) in every state the inbox has (Phase 5 spec WP5,
// gate G3a), in the light theme and the dark: empty, finishing, a conflict open, editing, the
// correction panel, undo shown, and the shortcuts dialog. One live region for review actions: the
// toaster's (the clip player's status line, outside <main>, speaks only when a clip is pressed).
test.setTimeout(240_000);

/** axe in both themes, leaving the page in the light one. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("axe: the empty inbox", async ({ page }) => {
  await openEmptyInbox(page);
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings → Data" })).toBeVisible();
  await expectNoViolations(page, "empty");
});

test("axe: finishing, a conflict open, editing, correcting, undo shown, and the shortcuts dialog", async ({
  page,
}) => {
  await openInboxWithSamples(page, { finishing: true });

  // Nothing in the page speaks but the toaster: no second live region.
  await expect(page.locator("main [aria-live]")).toHaveCount(0);

  // Finishing: the debrief that ended but isn't sealed waits below the cards.
  const finishing = page.getByRole("region", { name: "Finishing" });
  await expect(finishing).toContainText("Zenyth Packaging");
  await expect(finishing).toContainText("Finishing, usually under a minute");
  await expectNoViolations(page, "finishing");

  // A conflict open: the question's card focused, its records numbered. Accepting it with nothing
  // picked asks for a pick first, goes to the choices, and changes nothing.
  await focusCard(page, CARDS.dana);
  const choices = card(page, CARDS.dana).getByRole("radiogroup", { name: "Which record?" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await page.keyboard.press("a");
  await expect(card(page, CARDS.dana)).toContainText("Choose a record first");
  await expect(choices.getByRole("radio").first()).toBeFocused();
  await expect(cards(page)).toHaveCount(7);
  await expect(choices.getByRole("radio", { name: /Dana Lee, Acme Dynamics 41%/ })).toBeVisible();
  await choices.getByRole("radio", { name: /Dana Li, Akme Dynamics/ }).click();
  await expect(choices.getByRole("radio", { name: /Dana Li, Akme Dynamics/ })).toBeChecked();
  await expectNoViolations(page, "a conflict open");

  await focusCard(page, CARDS.pierAmount);

  // Editing: the inline editor, its errors tied to the field.
  await page.keyboard.press("e");
  const amount = card(page, CARDS.pierAmount).getByLabel("Amount", { exact: true });
  await expect(amount).toBeFocused();
  await amount.fill("a lot");
  await page.keyboard.press("Enter");
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(amount).toHaveAccessibleDescription(/Enter a number, like 40000\./);
  await expectNoViolations(page, "editing");
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(CARDS.pierAmount);

  // The correction panel: the record's candidates, numbered.
  await page.keyboard.press("c");
  await expect(
    card(page, CARDS.pierAmount).getByRole("group", { name: "Correct the record" }),
  ).toBeVisible();
  await expectNoViolations(page, "correcting");
  await page.keyboard.press("Escape");

  // Undo shown: the toast's Undo, and Reviewed's.
  await page.keyboard.press("a");
  await expect(card(page, CARDS.pierAmount)).toHaveCount(0);
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed.getByRole("button", { name: /^Undo: accepted/ })).toBeVisible();
  await expectNoViolations(page, "undo shown");

  // The shortcuts dialog.
  await focusCard(page, CARDS.pierTask);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Inbox keyboard shortcuts" })).toBeVisible();
  await expectNoViolations(page, "the shortcuts dialog");
  await page.keyboard.press("Escape");
  await reviewsSent(page);
});

test("axe: Settings → Review", async ({ page }) => {
  await openEmptyInbox(page);
  await page.goto("/settings/review");
  await expect(page.getByRole("switch", { name: "Single-key shortcuts" })).toBeVisible();
  await expectNoViolations(page, "Settings → Review");
});
