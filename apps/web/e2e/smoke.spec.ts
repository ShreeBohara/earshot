import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("home page renders with no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Earshot" })).toBeVisible();

  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("health chain reports web → edge → Durable Object and web → Postgres", async ({ request }) => {
  // A freshly deployed Worker can take a few seconds to answer everywhere.
  await expect
    .poll(async () => (await request.get("/api/health")).status(), { timeout: 60_000 })
    .toBe(200);

  const body = await (await request.get("/api/health")).json();
  expect(body.status).toBe("ok");
  expect(body.edge.durableObject).toBe("ok");
  if (process.env.EXPECT_BRANCH) expect(body.db.branch).toBe(process.env.EXPECT_BRANCH);
  if (process.env.EXPECT_SHA) expect(body.version).toBe(process.env.EXPECT_SHA);
});
