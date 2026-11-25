import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { signInAsNewUser } from "../support/sign-in";
import { cards, focused, hydrated, settled } from "./support";

// Corrections in the inbox (Phase 5 spec WP13; ADR-0038), over pilot.v1's sample debriefs:
// - a silent wrong account fixed with c, then 2: no marker said it was wrong, and the panel's
//   candidates stay on 1–3 under its new field picker;
// - a typed correction: Enter sends it to `POST /api/sessions/:id/corrections`, words it can't read
//   leave the card as it was with a line saying so, and the corrected card takes the original's
//   place and its focus.
test.setTimeout(240_000);

const cold = { timeout: 60_000 };

/** A new user with the demo CRM and pilot.v1's ten sample debriefs (40 cards) in the inbox. */
async function openInboxWithPilotSamples(page: Page): Promise<void> {
  test.skip(
    Boolean(process.env.BASE_URL),
    "Signs in with the local dev server's printed magic link.",
  );
  await signInAsNewUser(page);
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
  await expect(cards(page)).toHaveCount(40, cold);
  await hydrated(page);
}

/** axe in both themes (gate G3a), leaving the page in the light one. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("fixes a silent wrong account with c, then 2", async ({ page }) => {
  await openInboxWithPilotSamples(page);
  const toast = page.getByRole("region", { name: "Notifications" });

  // s02's seeded silent error: a note linked by sound to the wrong company, with no loud marker.
  const silent = cards(page).filter({ hasText: "reviewing the proposal with legal this week" });
  await expect(silent).toHaveCount(1);
  await expect(silent).not.toHaveAttribute("data-tier", "loud");
  await expect(silent.locator("[data-slot=first-person]")).toHaveCount(0);
  const heading = (await silent.getByRole("heading").textContent())?.trim() ?? "";
  const wrong = heading.replace(/^Note · /, "").replace(/, matched .*$/, "");
  expect(wrong).not.toBe("");

  // c opens the panel: the record preselected in its field picker, focus on the first candidate.
  await silent.focus();
  await page.keyboard.press("c");
  const panel = silent.getByRole("group", { name: "Correct the record" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("What's wrong")).toHaveValue("target");
  const records = panel.getByRole("radiogroup", { name: "Which is it?" });
  await expect(records.getByRole("radio").first()).toBeFocused();
  await expect(records.getByRole("radio").first()).toHaveAccessibleName(/the current record$/);
  await expect(panel.getByLabel("Or type the record's name")).toBeVisible();
  await expectNoViolations(page, "the correction panel");

  // 2 chooses the second candidate and accepts: the card leaves for Reviewed, on that record.
  await page.keyboard.press("2");
  await expect(silent).toHaveCount(0);
  await expect(toast).toContainText(/Chose (.+) and accepted: note for \1\./);
  const said = (await toast.textContent()) ?? "";
  const chosen = /Chose (.+?) and accepted/.exec(said)?.[1] ?? "";
  expect(chosen).not.toBe("");
  expect(chosen).not.toBe(wrong);
  await expect(page.locator("[data-inbox]")).toHaveAttribute("data-sending", "0", cold);

  // A reload reads it back from the log: 39 left.
  await page.reload();
  await expect(cards(page)).toHaveCount(39, cold);
  await expect(
    cards(page).filter({ hasText: "reviewing the proposal with legal this week" }),
  ).toHaveCount(0);
});

test("a typed correction: what it can't read changes nothing, and the corrected card takes the original's place and focus", async ({
  page,
}) => {
  await openInboxWithPilotSamples(page);
  const title = "Ping Thomas Berg about the pilot results";
  const task = () => cards(page).filter({ hasText: title });
  await expect(task()).toHaveCount(1);
  const heading = (await task().getByRole("heading").textContent())?.trim() ?? "";
  const before = (await task().locator("dl").textContent()) ?? "";
  const ids = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-proposal-id")),
  );
  const original = await task().getAttribute("data-proposal-id");
  const place = ids.indexOf(original);

  await task().focus();
  await page.keyboard.press("c");
  const panel = task().getByRole("group", { name: "Correct the record" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("What's wrong").selectOption("dueDate");
  // Not the record: its candidates go, and the text box asks for the field.
  await expect(panel.getByRole("radiogroup")).toHaveCount(0);
  const box = panel.getByLabel("The right due date");
  await box.fill("whenever suits them");
  await box.press("Enter");
  await expect(panel.locator("[data-slot=correction-error]")).toHaveText(
    "I couldn't read a date in “whenever suits them”.",
    cold,
  );
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(box).toHaveValue("whenever suits them");
  await expect(task()).toHaveCount(1);
  await expect(task().locator("dl")).toHaveText(before);
  await expectNoViolations(page, "a correction it couldn't read");

  // Words it can read: the corrected card replaces the original, in its place, with focus.
  await box.fill("December 14");
  await box.press("Enter");
  await expect.poll(() => task().getAttribute("data-proposal-id"), cold).not.toBe(original);
  await expect(task()).toHaveCount(1);
  await expect.poll(() => focused(page)).toBe(heading);
  await expect(task().locator("dl")).toContainText("14");
  await expect(task().locator("dl")).not.toHaveText(before);
  const after = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-proposal-id")),
  );
  expect(after.indexOf(await task().getAttribute("data-proposal-id"))).toBe(place);
  await expect(cards(page)).toHaveCount(40);
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Corrected:");

  // A reload reads the correction back from the log, still in the original's place.
  await page.reload();
  await expect(cards(page)).toHaveCount(40, cold);
  await expect(task().locator("dl")).toContainText("14");
  const reloaded = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-proposal-id")),
  );
  expect(reloaded.indexOf(await task().getAttribute("data-proposal-id"))).toBe(place);
});
