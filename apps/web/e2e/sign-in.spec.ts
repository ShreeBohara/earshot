import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// Runs against `next dev` (zero-setup PGlite, no secrets) or a deployed preview (BASE_URL).

async function seriousViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

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
  await expect(page.getByRole("alert")).toContainText("expired or was already used");
  expect(await seriousViolations(page)).toEqual([]);
});

test("signed-out visitors to a signed-in page are sent to sign-in, with the way back", async ({
  page,
}) => {
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Faccount$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("the replay demo renders without an account and passes axe", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1, name: "A debrief, replayed" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(5);
  expect(await seriousViolations(page)).toEqual([]);
});
