import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { signInAsNewUser } from "../support/sign-in";

// The second witness's consent (Phase 4 spec decision 8): asked once per device, only when a
// Groq key is on it, with "yes" preselected; Settings → Capture changes the answer. Nothing here
// reaches Groq: the key check is answered in the page, and no debrief starts.
test.skip(
  Boolean(process.env.BASE_URL),
  "Signs in with the local dev server's printed magic link.",
);
test.setTimeout(180_000);

/** Not a real key: /api/keys/validate is answered here and never reaches a provider. */
const GROQ_KEY = "gsk_E2EwitnessCanaryNotARealKey0123456789abcd";
const QUESTION = "Check names with a second witness?";

async function addGroqKey(page: Page): Promise<void> {
  await page.route("**/api/keys/validate", (route) =>
    route.fulfill({
      json: { ok: true, provider: "groq", last4: GROQ_KEY.slice(-4) },
      headers: { "cache-control": "no-store" },
    }),
  );
  await page.goto("/settings/keys");
  await page.getByLabel("Provider", { exact: true }).selectOption("groq");
  await page.getByLabel("Label", { exact: true }).fill("e2e");
  await page.getByLabel("Key", { exact: true }).fill(GROQ_KEY);
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved on this device" })).toBeVisible();
}

test("with a Groq key, the capture screen asks once, yes preselected, and Settings → Capture changes the answer", async ({
  page,
}) => {
  await signInAsNewUser(page);
  await addGroqKey(page);

  await page.goto("/capture");
  const prompt = page.getByRole("form", { name: QUESTION });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toContainText(
    "Sends each turn’s audio to Groq too, about $0.001 per debrief.",
  );
  await expect(prompt.getByLabel("Yes, use Groq Whisper on this device")).toBeChecked();
  expect(await seriousViolations(page)).toEqual([]);
  await prompt.getByRole("button", { name: "Save choice" }).click();
  await expect(prompt).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("earshot.capture.witness"))).toBe("groq");

  // Asked once: the answer holds on the next visit.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Debrief" })).toBeVisible();
  // The keys have loaded (a Groq key alone can't run a debrief), and still no question.
  await expect(page.getByText("Add your keys to start")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("form", { name: QUESTION })).toHaveCount(0);

  await page.goto("/settings/capture");
  await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
  const groq = page.getByLabel("Groq Whisper");
  await expect(groq).toBeChecked();
  await expect(groq).toBeEnabled();
  await page.getByLabel("Off").check();
  await expect(page.getByText("Saved on this device.")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("earshot.capture.witness"))).toBe("off");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await seriousViolations(page)).toEqual([]);
  }
  // The key never reached the page.
  expect(await page.content()).not.toContain(GROQ_KEY.slice(8));
});

test("without a Groq key, nothing is asked and Groq Whisper can't be picked", async ({ page }) => {
  await signInAsNewUser(page);
  await page.goto("/capture");
  await expect(page.getByText("Add your keys to start")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("form", { name: QUESTION })).toHaveCount(0);

  await page.goto("/settings/capture");
  await expect(page.getByLabel("Off")).toBeChecked();
  await expect(page.getByLabel("Groq Whisper")).toBeDisabled();
  await expect(page.getByText("It needs a Groq key on this device.")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
