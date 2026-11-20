import { expect, test } from "@playwright/test";
import { cards } from "../inbox/support";
import { signInAsNewUser } from "../support/sign-in";

// Settings → Data's "Load sample debriefs" loads pilot.v1 (Phase 5 spec WP7 step 4, decision 17):
// its ten sessions, mapped to the workspace's demo CRM, sealed, in the inbox with all 40 cards,
// the silent errors carrying the name note and the flagged ones loud, as on /pilot.
test.setTimeout(240_000);

test("Load sample debriefs brings pilot.v1's 40 cards into the inbox, seeded errors marked", async ({
  page,
}) => {
  test.skip(
    Boolean(process.env.BASE_URL),
    "Signs in with the local dev server's printed magic link.",
  );
  await signInAsNewUser(page);
  const cold = { timeout: 60_000 };
  await page.getByRole("button", { name: "Load the demo CRM" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded the demo CRM" })).toBeVisible(
    cold,
  );
  await page.goto("/settings/data");
  await page.getByRole("button", { name: "Load sample debriefs" }).click();
  await expect(
    page.getByText("Loaded 10 sample debriefs, with 40 proposals to review."),
  ).toBeVisible(cold);

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible(cold);
  await expect(cards(page)).toHaveCount(40, cold);
  await expect(page.locator("[data-slot=session-group]")).toHaveCount(10);
  // Every card links to the workspace's own demo records: none is "a CRM record".
  await expect(page.locator("[data-inbox-card]").filter({ hasText: "a CRM record" })).toHaveCount(
    0,
  );
  // The 4 silent errors are among the cards matched by sound; the 4 flagged ones are loud.
  expect(
    await page
      .locator("[data-inbox-card] [data-slot=name-note]", { hasText: "matched by sound" })
      .count(),
  ).toBeGreaterThanOrEqual(4);
  expect(await page.locator("[data-inbox-card][data-tier=loud]").count()).toBeGreaterThanOrEqual(4);

  // Loading them again adds nothing.
  await page.goto("/settings/data");
  await page.getByRole("button", { name: "Load sample debriefs" }).click();
  await expect(page.getByText("The sample debriefs are already loaded.")).toBeVisible(cold);
});
