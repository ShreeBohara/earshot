import { expect, type Locator, type Page, test } from "@playwright/test";
import { signInAsNewUser } from "../support/sign-in";

/**
 * The sample debriefs' proposals (packages/events/fixtures/samples), as the inbox names them once
 * the demo CRM is loaded: Pier Logistics (newest) first, then Acme Dynamics.
 */
export const CARDS = {
  /** A question: Dana Li (48%), Dana Lee (41%), or a new record. Loud. */
  dana: "Contact · Ask: Dana Li, Dana Lee, or a new record?",
  pierAmount: "Deal update · Pier Logistics - Expansion",
  pierTask: "Task · Pier Logistics",
  danaLee: "Contact · Dana Lee",
  acmeStage: "Deal update · Acme Dynamics - Expansion",
  seanTask: "Task · Sean Murphy",
  acmeNote: "Note · Acme Dynamics",
} as const;

/** Every card in "Needs review", in order. */
export function cards(page: Page): Locator {
  return page.locator("[data-inbox-card]");
}

/** The card whose heading is `name`. */
export function card(page: Page, name: string): Locator {
  return page.getByRole("article", { name, exact: true });
}

/** What has focus: a card's heading text, "All caught up", or the element's tag. */
export async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "<body>";
    const article = active.closest("[data-inbox-card]");
    if (article) {
      const id = article.getAttribute("aria-labelledby");
      const heading = id ? document.getElementById(id) : null;
      return heading?.textContent?.trim() ?? "a card";
    }
    return active.textContent?.trim() || active.tagName.toLowerCase();
  });
}

/** Fails if focus is on <body> (spec §4.8: it never falls there). */
export async function expectFocusOffBody(page: Page): Promise<void> {
  expect(await focused(page)).not.toBe("<body>");
}

/** Signs up a new user with an empty workspace and opens the inbox. */
export async function openEmptyInbox(page: Page): Promise<void> {
  test.skip(
    Boolean(process.env.BASE_URL),
    "Signs in with the local dev server's printed magic link.",
  );
  await signInAsNewUser(page);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

/**
 * Signs up a new user, loads the demo CRM (onboarding) and the sample debriefs (Settings → Data),
 * optionally the development-only finishing debrief too, and opens the inbox.
 */
export async function openInboxWithSamples(
  page: Page,
  options: { finishing?: boolean } = {},
): Promise<void> {
  test.skip(
    Boolean(process.env.BASE_URL),
    "Signs in with the local dev server's printed magic link.",
  );
  await signInAsNewUser(page);
  await page.getByRole("button", { name: "Load the demo CRM" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded the demo CRM" })).toBeVisible();
  await page.goto("/settings/data");
  await page.getByRole("button", { name: "Load sample debriefs" }).click();
  await expect(
    page.getByText(/Loaded 2 sample debriefs, with 7 proposals to review\./),
  ).toBeVisible();
  if (options.finishing) {
    await page.getByRole("button", { name: "Load a finishing debrief (development)" }).click();
    await expect(page.getByText(/Loaded a debrief that's still finishing/)).toBeVisible();
  }
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(cards(page)).toHaveCount(7);
}

/** Puts focus on a card the way a keyboard user would land on it: clicking its heading's card. */
export async function focusCard(page: Page, name: string): Promise<void> {
  await card(page, name).focus();
  expect(await focused(page)).toBe(name);
}

/**
 * Waits until every review the page made has reached the route: the first one compiles the route
 * under next dev, which can take a while on a cold server.
 */
export async function reviewsSent(page: Page): Promise<void> {
  await expect(page.locator("[data-inbox]")).toHaveAttribute("data-sending", "0", {
    timeout: 60_000,
  });
}
