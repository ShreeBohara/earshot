import { expect, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { signInAsNewUser } from "../support/sign-in";
import { captureStatus, proposalCards, sayWithSpace, transcript, waitUntilReady } from "./support";

// next dev compiles each page on first visit, and each line is held in real time.
test.setTimeout(180_000);

// Approval policies end to end (Phase 5 spec §4.6, WP11): a rep who just signed in saves "Auto-approve
// notes" in Settings → Review; the next debrief's `POST /api/sessions` signs that policy for the
// session, the capture screen sends it in `start`, and the e2e edge Worker's SessionDO verifies it
// and approves eval script d003's first proposal as it's made: a note for Atmos Industrial, linked
// by its exact name, with nothing to mark. The tray shows it in Reviewed, "Approved by your policy:
// notes", and its Undo reopens it over the socket, as any review's does.
const SAID =
  "Debrief from Atmos Industrial. Raj Patel says finance wants to restart the onboarding package they passed on in June.";

test("a policy saved in Settings → Review approves the next debrief's note as it's made, in Reviewed with Undo", async ({
  page,
}) => {
  test.skip(Boolean(process.env.BASE_URL), "Fake mode exists only under next dev.");
  await signInAsNewUser(page);

  // A fresh sign-in, so the policy can change right away: no step-up asked for.
  await page.goto("/settings/review");
  await expect(page.getByRole("heading", { level: 2, name: "Approval policy" })).toBeVisible();
  await expect(page.locator("[data-slot=policy-version]")).toHaveText(
    "No policy yet: every proposal waits for your review.",
  );
  await expect(page.locator("[data-slot=step-up]")).toHaveCount(0);
  const notes = page.getByRole("switch", { name: "Auto-approve notes" });
  await expect(notes).not.toBeChecked();
  await notes.click();
  await expect(notes).toBeChecked();
  // A deal update's fields to hold back appear only once its switch is on.
  const deals = page.getByRole("switch", { name: "Auto-approve deal updates" });
  await deals.click();
  await page.getByRole("checkbox", { name: /^Amount/ }).check();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(
    page.getByText("Saved as version 1. It applies from your next debrief."),
  ).toBeVisible();
  await expect(page.locator("[data-slot=policy-version]")).toContainText(
    "Version 1, changed by you",
  );
  // Loaded afresh, the page shows the saved policy; axe runs on it there, not mid-refresh, when
  // next dev can be between head elements.
  await page.reload();
  await expect(page).toHaveTitle("Review · Settings · Earshot");
  await expect(page.locator("[data-slot=policy-version]")).toContainText(
    "Version 1, changed by you",
  );
  await expect(notes).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Amount/ })).toBeChecked();
  expect(await seriousViolations(page)).toEqual([]);

  // The next debrief: d003's first line.
  await page.goto("/capture?voice=fake&script=d003");
  await expect(page.getByText("Fake voice (development)")).toBeVisible();
  const start = page.getByRole("button", { name: "Start debrief" });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
  await waitUntilReady(page);
  await sayWithSpace(page);
  await expect(transcript(page).locator("p")).toHaveText([SAID], { timeout: 20_000 });

  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed).toContainText(
    "Approved by your policy: notes · Note for Atmos Industrial",
    {
      timeout: 20_000,
    },
  );
  await expect(proposalCards(page)).toHaveCount(0);
  await expect(page.locator("[data-slot=caught-up]")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  // Undo: a reopen naming the policy's review, over the socket. The card comes back for review.
  await reviewed
    .getByRole("button", {
      name: "Undo: approved by your policy: notes, note for Atmos Industrial",
    })
    .click();
  const card = proposalCards(page).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading")).toHaveText(/^Note · Atmos Industrial/);
  await expect(page.getByRole("region", { name: "Reviewed" })).toHaveCount(0);
  await expect(captureStatus(page)).toHaveText("Ready: hold to talk");
});
