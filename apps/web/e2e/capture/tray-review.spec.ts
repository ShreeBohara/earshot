import { expect, test } from "@playwright/test";
import {
  captureStatus,
  openFakeCapture,
  proposalCards,
  sayWithSpace,
  transcript,
  waitUntilReady,
} from "./support";

// The capture screen's tray on the inbox's card (Phase 5 spec WP6 step 2): its keys, scoped to the
// list, review over the session socket; the screen's own shortcuts (H, P, Esc) ignore keys from
// the list, so Esc in a tray editor, a card's menu, or its correction panel never ends the
// session; and after `end` the tray keeps reviewing until the seal. The hand-over at the seal is
// tested on the in-memory SessionDO (test/tray-reviews.test.ts, test/capture-controller.test.ts):
// the e2e Worker seals a minute after the last write, and zero-setup development has no flush.
test.setTimeout(180_000);

test("the tray reviews by key over the socket, and Esc inside it never ends the session", async ({
  page,
}) => {
  const routePosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/sessions\/[^/]+\/reviews$/.test(request.url())) {
      routePosts.push(request.url());
    }
  });
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);
  const endButton = page.getByRole("button", { name: /End debrief/ });

  // Line 1: a contact the linker asks about; line 2: nothing to propose; line 3: a deal update.
  await sayWithSpace(page);
  await expect(proposalCards(page).first()).toBeVisible({ timeout: 20_000 });
  await sayWithSpace(page);
  await expect(transcript(page).locator("p")).toHaveCount(2, { timeout: 20_000 });
  await sayWithSpace(page);
  const deal = proposalCards(page).filter({
    has: page.getByRole("heading", { name: /^Deal update · / }),
  });
  await expect(deal).toBeVisible({ timeout: 20_000 });

  // The question is the inbox's loud card: its first-person line and its numbered records.
  const contact = proposalCards(page).first();
  await expect(contact.locator("[data-slot=first-person]")).toBeVisible();
  await expect(contact.getByRole("radiogroup", { name: "Which record?" })).toBeVisible();

  // e opens the deal update's editor; Esc in a field cancels it, and the session goes on.
  await deal.focus();
  await page.keyboard.press("e");
  const editor = deal.locator("[data-inbox-editor]");
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(deal).toBeFocused();
  await expect(endButton).toBeEnabled();
  await expect(captureStatus(page)).toHaveText("Ready: hold to talk");

  // Esc on the editor's buttons, which aren't text fields, doesn't end it either.
  await page.keyboard.press("e");
  await editor.getByRole("button", { name: "Save and accept" }).focus();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(endButton).toBeEnabled();

  // Nor Esc closing a card's More menu, or its correction panel.
  await deal.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(endButton).toBeEnabled();
  await deal.focus();
  await page.keyboard.press("c");
  const panel = deal.getByRole("group", { name: "Correct the record" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(endButton).toBeEnabled();

  // The screen's letters stay out of the list: h doesn't switch to hands-free, p doesn't pause.
  await expect(deal).toBeFocused();
  await page.keyboard.press("h");
  await page.keyboard.press("p");
  await expect(page.getByRole("button", { name: /Hands-free/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByText("Live updates are paused; capture carries on.")).toHaveCount(0);

  // a accepts over the socket: the card leaves, focus moves to the previous card, one polite
  // message says so, and the tray's Reviewed keeps Undo.
  await page.keyboard.press("a");
  await expect(deal).toHaveCount(0);
  await expect
    .poll(() => contact.evaluate((element) => element === document.activeElement))
    .toBe(true);
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText(/Accepted: deal update for .+\. 1 left\. Press U to undo\./);
  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed.getByRole("listitem")).toHaveCount(1);

  // u brings it back, focused.
  await page.keyboard.press("u");
  await expect(deal).toBeVisible();
  await expect(deal).toBeFocused();
  await expect(reviewed).toHaveCount(0);

  // After `end`, the tray keeps reviewing until the seal: still over the socket.
  await endButton.click();
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-slot=finishing]")).toBeVisible();
  await deal.getByRole("button", { name: "Reject" }).click();
  await expect(deal).toHaveCount(0);
  await expect(reviewed.getByRole("listitem")).toHaveCount(1);
  await expect(reviewed).toContainText("Rejected");
  await page.waitForTimeout(1_000);
  expect(routePosts).toEqual([]);
});
