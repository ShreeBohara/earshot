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

// The review inbox by keyboard (Phase 5 spec WP5): accept, undo with u, choose with 2, reject,
// snooze, and edit, each by its key, with focus moving by the rules and never landing on <body>,
// and every review reaching the log through the web route (a reload shows them).
test.setTimeout(180_000);

test("reviews by keyboard: accept, undo with u, choose with 2, reject, snooze, and edit", async ({
  page,
}) => {
  await openInboxWithSamples(page);
  const toast = page.getByRole("region", { name: "Notifications" });

  // The groups: newest debrief first, each list labelled by its account and time.
  await expect(page.getByRole("list", { name: /^Pier Logistics · / })).toBeVisible();
  await expect(page.getByRole("list", { name: /^Acme Dynamics · / })).toBeVisible();
  // Only one card is in the tab order: the first.
  await expect(card(page, CARDS.dana)).toHaveAttribute("tabindex", "0");
  await expect(card(page, CARDS.pierAmount)).toHaveAttribute("tabindex", "-1");
  // The loud card says why, in the first person, and that's its description too.
  await expect(card(page, CARDS.dana)).toHaveAccessibleDescription(
    "Contact, Dana Li, needs a check: I'm not sure who you meant.",
  );

  // j moves; a accepts; focus moves to the next card in the group.
  await focusCard(page, CARDS.dana);
  await page.keyboard.press("j");
  await expect.poll(() => focused(page)).toBe(CARDS.pierAmount);
  await page.keyboard.press("a");
  await expect(card(page, CARDS.pierAmount)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);
  await expect(toast).toContainText(
    "Accepted: deal update for Pier Logistics - Expansion. 6 left. Press U to undo.",
  );

  // u undoes it: the card comes back and takes focus.
  await page.keyboard.press("u");
  await expect(card(page, CARDS.pierAmount)).toBeVisible();
  await expect.poll(() => focused(page)).toBe(CARDS.pierAmount);
  await expect(toast).toContainText(
    "Back for review: deal update for Pier Logistics - Expansion. 7 left.",
  );

  // 2 on the question chooses Dana Lee and accepts.
  await page.keyboard.press("k");
  await expect.poll(() => focused(page)).toBe(CARDS.dana);
  await page.keyboard.press("2");
  await expect(card(page, CARDS.dana)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierAmount);
  await expect(toast).toContainText(
    "Chose Dana Lee and accepted: contact for Dana Lee. 6 left. Press U to undo.",
  );

  // r rejects.
  await page.keyboard.press("r");
  await expect(card(page, CARDS.pierAmount)).toHaveCount(0);
  await expect(toast).toContainText(
    "Rejected: deal update for Pier Logistics - Expansion. 5 left.",
  );
  // It was the group's second card, now its first: focus goes to the next one.
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);

  // s snoozes until tomorrow at 9:00; the group's last card leaves, so focus goes to the next group.
  await page.keyboard.press("s");
  await expect(card(page, CARDS.pierTask)).toHaveCount(0);
  await expect(toast).toContainText(/Snoozed until tomorrow, 9:00 am: task for Pier Logistics\./);
  await expect.poll(() => focused(page)).toBe(CARDS.danaLee);
  await expect(page.getByRole("region", { name: "Snoozed" })).toContainText(
    "Task for Pier Logistics",
  );

  // e edits: the title takes focus, Enter saves as edited, focus moves on.
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect.poll(() => focused(page)).toBe(CARDS.seanTask);
  await page.keyboard.press("e");
  const title = card(page, CARDS.seanTask).getByLabel("Title", { exact: true });
  await expect(title).toBeFocused();
  await title.fill("Send Sean Murphy the revised pricing sheet");
  await page.keyboard.press("Enter");
  await expect(card(page, CARDS.seanTask)).toHaveCount(0);
  await expect(toast).toContainText("Edited and accepted: task for Sean Murphy. 3 left.");
  await expect.poll(() => focused(page)).toBe(CARDS.acmeNote);
  await expectFocusOffBody(page);

  // Reviewed keeps every decision, with Undo while its window is open.
  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed.getByRole("listitem")).toHaveCount(3);
  await expect(reviewed).toContainText("Edited and accepted");
  await expect(reviewed).toContainText("Rejected");
  await expect(reviewed.getByRole("button", { name: /^Undo/ }).first()).toBeVisible();

  // The last cards: when the list empties, "All caught up" takes focus, and u brings the last back.
  for (const name of [CARDS.acmeNote, CARDS.acmeStage, CARDS.danaLee]) {
    await expect.poll(() => focused(page)).toBe(name);
    await page.keyboard.press("a");
    await expect(card(page, name)).toHaveCount(0);
  }
  await expect.poll(() => focused(page)).toBe("All caught up");
  await page.keyboard.press("u");
  await expect.poll(() => focused(page)).toBe(CARDS.danaLee);
  await expect(cards(page)).toHaveCount(1);

  // Every review reached the log: a reload shows the same inbox.
  await reviewsSent(page);
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Reviewed" }).getByRole("listitem")).toHaveCount(5);
  await expect(page.getByRole("region", { name: "Snoozed" }).getByRole("listitem")).toHaveCount(1);
});

test("by pointer and the correction panel: More snoozes, c and a digit choose the record, focus moves on", async ({
  page,
}) => {
  await openInboxWithSamples(page);
  const toast = page.getByRole("region", { name: "Notifications" });

  // More → For 3 hours: the menu closes, and focus goes to the next card, not back to the menu.
  const amount = card(page, CARDS.pierAmount);
  await amount.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "For 3 hours" }).click();
  await expect(amount).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.pierTask);
  await expect(toast).toContainText(
    /Snoozed until .*: deal update for Pier Logistics - Expansion\./,
  );
  // Snoozed lists it, and Review now brings it back, focused.
  const snoozed = page.getByRole("region", { name: "Snoozed" });
  await snoozed
    .getByRole("button", { name: "Review now: deal update for Pier Logistics - Expansion" })
    .click();
  await expect.poll(() => focused(page)).toBe(CARDS.pierAmount);
  await expect(snoozed).toHaveCount(0);

  // c on a linked card opens the correction panel, focus inside; a digit there chooses and accepts.
  await focusCard(page, CARDS.danaLee);
  await page.keyboard.press("c");
  const panel = card(page, CARDS.danaLee).getByRole("group", { name: "Correct the record" });
  await expect(
    panel.getByRole("radio", { name: /Dana Lee, Acme Dynamics 97%, the current record/ }),
  ).toBeFocused();
  await page.keyboard.press("1");
  await expect(card(page, CARDS.danaLee)).toHaveCount(0);
  await expect(toast).toContainText("Chose Dana Lee and accepted: contact for Dana Lee.");
  await expect.poll(() => focused(page)).toBe(CARDS.acmeStage);

  // Clicking Reject: focus moves on just the same.
  await card(page, CARDS.acmeStage).getByRole("button", { name: "Reject" }).click();
  await expect(card(page, CARDS.acmeStage)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe(CARDS.seanTask);
  await expectFocusOffBody(page);
  await reviewsSent(page);
});
