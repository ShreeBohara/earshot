import { expect, test } from "@playwright/test";
import { seriousViolations } from "./support/axe";

// Runs against `next dev` (zero-setup PGlite, no secrets) or a deployed preview (BASE_URL).

for (const colorScheme of ["light", "dark"] as const) {
  test(`sign-in page renders every option and passes axe (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test("an expired or reused link explains itself", async ({ page }) => {
  await page.goto("/sign-in?error=INVALID_TOKEN");
  // By its words: once the page hydrates, Next's route announcer is a role="alert" too.
  await expect(
    page.getByRole("alert").filter({ hasText: "expired or was already used" }),
  ).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("signed-out visitors to a signed-in page are sent to sign-in, with the way back", async ({
  page,
}) => {
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Faccount$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
