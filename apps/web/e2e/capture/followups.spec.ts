import { expect, test } from "@playwright/test";
import { seriousViolations, settled } from "../support/axe";
import {
  captureStatus,
  openFakeCapture,
  proposalCards,
  sayWithSpace,
  transcript,
  waitUntilReady,
} from "./support";

// Follow-up questions in the capture screen's tray (Phase 5 spec WP13; ADR-0038): after the turn
// that moves the deal's stage with no amount, SessionDO asks "What's the amount?" on a card right
// after the deal's. c answers it in a text box whose Enter sends the words on `correct` over the
// socket: SessionDO reads them with `correctProposal` (no model call, no key), the corrected deal
// takes the original's place and its focus, and the question closes. It's never a proposal card.
test.setTimeout(180_000);

test("c answers a follow-up question over the socket, and the corrected card takes its place", async ({
  page,
}) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);

  // Line 1: a contact the linker asks about (loud: no question); line 2: nothing; line 3: the deal.
  await sayWithSpace(page);
  await expect(proposalCards(page).first()).toBeVisible({ timeout: 20_000 });
  await sayWithSpace(page);
  await expect(transcript(page).locator("p")).toHaveCount(2, { timeout: 20_000 });
  await sayWithSpace(page);
  const tray = page.getByRole("region", { name: "Proposals" });
  const deal = proposalCards(page).filter({
    has: page.getByRole("heading", { name: /^Deal update · / }),
  });
  await expect(deal).toBeVisible({ timeout: 20_000 });
  const heading = (await deal.getByRole("heading").textContent())?.trim() ?? "";
  const original = await deal.getAttribute("data-proposal-id");

  // The question sits right after the deal's card, as a group, not an article.
  const question = tray.locator("[data-inbox-followup]");
  await expect(question).toHaveCount(1, { timeout: 20_000 });
  await expect(question).toHaveAccessibleName(/^What's the amount\? · Deal update · /);
  await expect(proposalCards(page)).toHaveCount(2);
  const order = await tray
    .locator("[data-inbox-card], [data-inbox-followup]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.hasAttribute("data-inbox-followup") ? "question" : "card")),
    );
  expect(order).toEqual(["card", "card", "question"]);
  await expect(question.getByRole("button", { name: /^Answer/ })).toHaveAttribute(
    "aria-keyshortcuts",
    "C",
  );
  await expect(question.getByRole("button", { name: /^Skip/ })).toHaveAttribute(
    "aria-keyshortcuts",
    "R",
  );

  // j from the deal reaches the question; c opens its answer box, focus inside.
  await deal.focus();
  await page.keyboard.press("j");
  await expect(question).toBeFocused();
  await page.keyboard.press("c");
  const answer = question.getByLabel("Your answer");
  await expect(answer).toBeFocused();
  await settled(page);
  expect(await seriousViolations(page), "answering").toEqual([]);

  // Esc closes the box without ending the session; c opens it again.
  await page.keyboard.press("Escape");
  await expect(answer).toHaveCount(0);
  await expect(question).toBeFocused();
  await expect(page.getByRole("button", { name: /End debrief/ })).toBeEnabled();
  await page.keyboard.press("c");
  await expect(answer).toBeFocused();

  // Enter sends it: the corrected deal replaces the original, in its place, focused, with the
  // amount; the question is answered and gone.
  await answer.fill("$40,000");
  await answer.press("Enter");
  await expect
    .poll(() => deal.getAttribute("data-proposal-id"), { timeout: 20_000 })
    .not.toBe(original);
  await expect(question).toHaveCount(0);
  await expect(deal).toBeFocused();
  await expect(deal.getByRole("heading")).toHaveText(heading);
  await expect(deal.locator("dl")).toContainText(/40,000/);
  await expect(proposalCards(page)).toHaveCount(2);
  await expect(captureStatus(page)).toHaveText("Ready: hold to talk");
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Corrected:");
});

test("r skips a follow-up question: it closes, and focus moves on as when a card leaves", async ({
  page,
}) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);
  await sayWithSpace(page);
  await expect(proposalCards(page).first()).toBeVisible({ timeout: 20_000 });
  await sayWithSpace(page);
  await expect(transcript(page).locator("p")).toHaveCount(2, { timeout: 20_000 });
  await sayWithSpace(page);
  const tray = page.getByRole("region", { name: "Proposals" });
  const deal = proposalCards(page).filter({
    has: page.getByRole("heading", { name: /^Deal update · / }),
  });
  await expect(deal).toBeVisible({ timeout: 20_000 });
  const original = await deal.getAttribute("data-proposal-id");
  const question = tray.locator("[data-inbox-followup]");
  await expect(question).toHaveCount(1, { timeout: 20_000 });

  await question.focus();
  await page.keyboard.press("r");
  await expect(question).toHaveCount(0);
  // The question was the list's last stop: focus goes back to the card before it, unchanged.
  await expect(deal).toBeFocused();
  expect(await deal.getAttribute("data-proposal-id")).toBe(original);
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText(
    "Skipped the question: What's the amount?",
  );
  await expect(proposalCards(page)).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Reviewed" })).toHaveCount(0);
});
