import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "./support/axe";
import { signInAsNewUser } from "./support/sign-in";

// Runs against the zero-setup dev server (in-process PGlite, no secrets, so no vault). Each test
// signs up its own user from the magic link the server prints, so not against a deployed
// preview, which emails its links.
test.skip(
  Boolean(process.env.BASE_URL),
  "Signs in with the local dev server's printed magic link.",
);
// next dev compiles each page on its first visit.
test.setTimeout(120_000);

/** Not a real key: /api/keys/validate is answered here and never reaches a provider. */
const KEY = "sk-proj-E2EcanaryNotARealKeyQz7Xw2Lp9Rt4abcd";

type CheckRequest = { key: string | undefined; body: string | null; url: string };

/** Answers every key check as the provider accepting the key, and records what was sent. */
async function stubKeyChecks(page: Page): Promise<CheckRequest[]> {
  const checks: CheckRequest[] = [];
  await page.route("**/api/keys/validate", async (route) => {
    const request = route.request();
    checks.push({
      key: request.headers()["x-earshot-provider-key"],
      body: request.postData(),
      url: request.url(),
    });
    await route.fulfill({
      json: { ok: true, provider: "openai", last4: KEY.slice(-4) },
      headers: { "cache-control": "no-store" },
    });
  });
  return checks;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`Settings → Keys adds, checks, and removes a key on this device, and passes axe (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    const checks = await stubKeyChecks(page);
    await signInAsNewUser(page);

    await page.goto("/settings/keys");
    await expect(page.getByRole("heading", { level: 1, name: "Keys" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "On this device" })).toBeVisible();
    await expect(page.getByText("No keys on this device yet")).toBeVisible();
    // Zero-setup mode sets no vault master key, so the vault section isn't offered. (The dev
    // server sees this process's environment: playwright.config.ts.)
    if (!process.env.EARSHOT_VAULT_MASTER_KEY) {
      const vault = page.getByRole("heading", { name: "Stored on the server (vault)" });
      await expect(vault).toHaveCount(0);
    }
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    await page.getByLabel("Label", { exact: true }).fill("e2e");
    await page.getByLabel("Key", { exact: true }).fill(KEY);
    await page.getByRole("button", { name: "Check and save" }).click();

    await expect(
      page.getByRole("status").filter({ hasText: "Saved on this device" }),
    ).toBeVisible();
    // The field is cleared, and the page never shows the key.
    await expect(page.getByLabel("Key", { exact: true })).toHaveValue("");
    expect(await page.content()).not.toContain(KEY.slice(8));
    const list = page.getByRole("list", { name: "Keys on this device" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("OpenAI");
    await expect(list).toContainText("e2e");
    await expect(list).toContainText(KEY.slice(-4));
    await expect(list.getByText("Checked", { exact: true })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    // The key went out in the header, never in the body or the URL.
    expect(checks).toEqual([
      { key: KEY, body: JSON.stringify({ provider: "openai" }), url: expect.any(String) },
    ]);
    expect(checks[0]?.url).not.toContain(KEY.slice(8));

    // It's stored on this device: a reload reads it back from IndexedDB, and checking it again
    // decrypts it for that one request.
    await page.reload();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await list.getByRole("button", { name: "Check again: OpenAI key “e2e”" }).click();
    await expect.poll(() => checks.length).toBe(2);
    expect(checks[1]?.key).toBe(KEY);
    await expect(list.getByText("Checked", { exact: true })).toBeVisible();

    await list.getByRole("button", { name: "Remove the OpenAI key “e2e”" }).click();
    await page.getByRole("button", { name: "Yes, remove the OpenAI key “e2e”" }).click();
    await expect(page.getByText("No keys on this device yet")).toBeVisible();
    await page.reload();
    await expect(page.getByText("No keys on this device yet")).toBeVisible();
  });
}

test("onboarding offers the demo CRM, and Settings → Data loads and removes it", async ({
  page,
}) => {
  await signInAsNewUser(page);
  await expect(page.getByRole("heading", { level: 2, name: "Load the demo CRM" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Load the demo CRM" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded the demo CRM" })).toBeVisible();

  await page.goto("/settings/data");
  await expect(page.getByRole("heading", { level: 1, name: "Data" })).toBeVisible();
  await expect(page.getByText(/^All \d+ records are in your workspace\.$/)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Remove the demo CRM" }).click();
  await page.getByRole("button", { name: "Yes, remove the demo CRM" }).click();
  await expect(page.getByText("Your workspace has none of it.")).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await seriousViolations(page)).toEqual([]);
  }
});
