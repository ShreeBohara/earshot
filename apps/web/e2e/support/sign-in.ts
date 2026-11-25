import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

// Signing in for real against the zero-setup dev server, which has no email provider and prints
// each magic link to its terminal, development only (lib/auth/email.ts). playwright.config.ts
// copies that output to this file, and the link is read from it.
export const DEV_SERVER_LOG = path.join(import.meta.dirname, "../../.data/e2e/dev-server.log");

const MAGIC_LINK = /http:\/\/localhost:\d+\/api\/auth\/magic-link\/verify\?[\w%.~&=+-]+/g;

async function logSize(): Promise<number> {
  try {
    return (await stat(DEV_SERVER_LOG)).size;
  } catch {
    return 0;
  }
}

/** The magic link carrying `nonce` that the server printed after `offset` bytes of its log. */
async function linkPrintedAfter(offset: number, nonce: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const printed = (await readFile(DEV_SERVER_LOG)).subarray(offset).toString("utf8");
      const link = printed.match(MAGIC_LINK)?.find((candidate) => candidate.includes(nonce));
      if (link) return link;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `No magic link appeared in ${DEV_SERVER_LOG}. Playwright's own dev server writes it there; ` +
      "if another server already holds port 3100, stop it and run the tests again.",
  );
}

/**
 * Signs up a new user through the sign-in page and the magic link it sends, and returns their
 * address. New users land on onboarding. The link is found by a nonce in its callback URL, which
 * the console prints but nothing else uses, so tests in parallel never take each other's links.
 */
export async function signInAsNewUser(page: Page): Promise<string> {
  const nonce = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const email = `${nonce}@earshot.example`;
  await page.goto(`/sign-in?next=${encodeURIComponent(`/home?from=${nonce}`)}`);
  const offset = await logSize();
  // On a cold dev server the form can take its address and the click before it hydrates, and a
  // controlled input then loses both: the page never says it sent a link. Try again until it does.
  // A second link carries the same nonce, and the first one printed is taken.
  const sent = page.getByRole("heading", { name: "Check your email" });
  await expect(async () => {
    if (!(await sent.isVisible())) {
      await page.getByLabel("Email").fill(email, { timeout: 5_000 });
      await page.getByRole("button", { name: "Email me a sign-in link" }).click({ timeout: 5_000 });
    }
    await expect(sent).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await page.goto(await linkPrintedAfter(offset, nonce));
  await expect(page).toHaveURL(/\/onboarding$/);
  return email;
}
