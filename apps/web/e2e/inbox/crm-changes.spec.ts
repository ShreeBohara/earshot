import { expect, type Locator, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import {
  CARDS,
  card,
  focusCard,
  focused,
  openInboxWithSamples,
  reviewsSent,
  settled,
} from "./support";

// The mirror's history in the inbox (Phase 5 spec WP12): the demo control "Simulate a CRM change",
// only in the More menu of cards whose record is a demo record, moves the Acme deal's stage in the
// demo CRM; the card then shows three values and is loud at review time, "accept all" leaves it,
// it passes axe in both themes, and 2 keeps the CRM's value, an edit the route records with what
// was seen.
test.setTimeout(240_000);

interface PostedReview {
  readonly proposalId: string;
  readonly decision: string;
  readonly mode: string;
  readonly editDiff?: Record<string, { before: unknown; after: unknown }>;
  readonly seen: {
    readonly tier: string;
    readonly fields: Record<string, { proposed: unknown; base?: unknown; current?: unknown }>;
    readonly relinked: string | null;
  };
}

/** Every review the page posts to the review route, in order. */
function recordReviews(page: Page): PostedReview[] {
  const posted: PostedReview[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/api\/sessions\/[^/]+\/reviews$/.test(request.url())) {
      return;
    }
    const body = request.postDataJSON() as { reviews?: PostedReview[] };
    posted.push(...(body.reviews ?? []));
  });
  return posted;
}

function group(page: Page, account: string): Locator {
  return page
    .locator("[data-slot=session-group]")
    .filter({ has: page.getByRole("heading", { level: 3, name: new RegExp(`^${account} · `) }) });
}

/** axe in both themes, leaving the page in the light one. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens a card's More menu and lists its items' names, without their keys. */
async function menuItems(page: Page, name: string): Promise<string[]> {
  await card(page, name).getByRole("button", { name: "More" }).click();
  const menu = page.locator("[role=menu][data-open]");
  await expect(menu).toBeVisible();
  const items = await menu.getByRole("menuitem").allTextContents();
  return items.map((item) => item.replace(/[A-Z]$/, "").trim());
}

/** Closes the open menu and waits until it's gone, so the next one is the only one. */
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("a simulated CRM change shows the card three ways, and 2 keeps the CRM's value", async ({
  page,
}) => {
  const posted = recordReviews(page);
  await openInboxWithSamples(page);
  const toast = page.getByRole("region", { name: "Notifications" });
  const acme = card(page, CARDS.acmeStage);

  // The demo control sits only on cards whose record is a demo record and can show a change: the
  // stage update and the contact update, not the task or the note.
  expect(await menuItems(page, CARDS.seanTask)).not.toContain("Simulate a CRM change");
  await closeMenu(page);
  expect(await menuItems(page, CARDS.danaLee)).toContain("Simulate a CRM change");
  await closeMenu(page);
  await expect(
    group(page, "Acme Dynamics").getByRole("button", { name: "Accept 3 unmarked" }),
  ).toBeVisible();

  // Before the change: before → after, no marker.
  await expect(acme.locator("[data-slot=three-way]")).toHaveCount(0);
  await expect(acme.getByText("Needs a check", { exact: true })).toHaveCount(0);

  expect(await menuItems(page, CARDS.acmeStage)).toContain("Simulate a CRM change");
  await page
    .locator("[role=menu][data-open]")
    .getByRole("menuitem", { name: "Simulate a CRM change" })
    .click();
  await expect(toast).toContainText("Changed the stage in the demo CRM to Qualified to buy.", {
    timeout: 60_000,
  });

  // The card reads again with three values, loud, and says so in its description.
  const row = acme.locator("[data-slot=three-way]");
  await expect(row).toContainText("Appointment scheduled when you spoke", { timeout: 30_000 });
  await expect(row).toContainText("Qualified to buy in the CRM now (changed just now)");
  await expect(row).toContainText("you said proposal");
  await expect(acme.getByText("Needs a check", { exact: true })).toBeVisible();
  await expect(acme).toHaveAccessibleDescription(
    "Deal update, Acme Dynamics - Expansion, needs a check: The stage changed in your CRM after you spoke.",
  );
  await expect(acme.getByRole("button", { name: "Keep mine" })).toHaveAttribute(
    "aria-keyshortcuts",
    "A 1",
  );
  await expect(acme.getByRole("button", { name: "Keep the CRM's" })).toHaveAttribute(
    "aria-keyshortcuts",
    "2",
  );
  await expectNoViolations(page, "a 3-way card");

  // "Accept all" leaves it out now, and says why.
  const acceptAll = group(page, "Acme Dynamics").getByRole("button", { name: "Accept 2 unmarked" });
  await acceptAll.click();
  const checkpoint = page.getByRole("group", { name: "Accept all from this call" });
  await expect(checkpoint.locator("[data-slot=stays]")).toContainText(
    "Deal update · Acme Dynamics - ExpansionNeeds a check: The stage changed in your CRM after you spoke.",
  );
  await expect(checkpoint.locator("[data-slot=accepts]")).not.toContainText("Deal update");
  await checkpoint.getByRole("button", { name: "Cancel" }).click();

  // 2 keeps the CRM's value: an edit to it, with the three values as seen.
  await focusCard(page, CARDS.acmeStage);
  await page.keyboard.press("2");
  await expect(acme).toHaveCount(0);
  await expect(toast).toContainText(
    "Kept the CRM's stage: deal update for Acme Dynamics - Expansion.",
  );
  expect(await focused(page)).not.toBe("<body>");
  await reviewsSent(page);
  const kept = posted.at(-1);
  expect(kept).toMatchObject({
    decision: "edited",
    mode: "single",
    editDiff: { stage: { before: "proposal", after: "qualifiedtobuy" } },
    seen: {
      tier: "loud",
      fields: {
        stage: { proposed: "proposal", base: "appointmentscheduled", current: "qualifiedtobuy" },
      },
      relinked: null,
    },
  });

  // The log holds it: after a reload it's in Reviewed, edited.
  await page.reload();
  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed).toContainText("Edited and accepted", { timeout: 60_000 });
  await expect(reviewed).toContainText("Deal update for Acme Dynamics - Expansion");
});
