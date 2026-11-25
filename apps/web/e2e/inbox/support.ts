import { expect, type Locator, type Page, test } from "@playwright/test";
import { signInAsNewUser } from "../support/sign-in";

/**
 * The test debriefs' proposals (packages/events/fixtures/samples, which Settings → Data loads under
 * next dev), as the inbox names them once the demo CRM is loaded: Pier Logistics (newest) first,
 * then Acme Dynamics.
 */
export const CARDS = {
  /** A question: Dana Li (48%), Dana Lee (41%), or a new record. Loud. */
  dana: "Contact · Ask: Dana Li, Dana Lee, or a new record?",
  /** Linked in context, below 0.97: quiet, with the name note beside the record. */
  pierAmount: "Deal update · Pier Logistics - Expansion, matched in context",
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

export { settled } from "../support/axe";

/** Signs up a new user with an empty workspace and opens the inbox. */
export async function openEmptyInbox(page: Page): Promise<void> {
  test.skip(
    Boolean(process.env.BASE_URL),
    "Signs in with the local dev server's printed magic link.",
  );
  await signInAsNewUser(page);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({
    timeout: 60_000,
  });
}

/**
 * Signs up a new user, loads the demo CRM (onboarding) and the test debriefs (Settings → Data's
 * development-only control: WP3's two, seven cards with one in every tier), optionally the
 * development-only finishing debrief too, and opens the inbox. "Load sample debriefs" itself loads
 * pilot.v1, which e2e/pilot/ checks.
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
  // next dev compiles each page and server action on first use: allow for a cold server.
  const cold = { timeout: 60_000 };
  await page.getByRole("button", { name: "Load the demo CRM" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded the demo CRM" })).toBeVisible(
    cold,
  );
  await page.goto("/settings/data");
  await page.getByRole("button", { name: "Load the test debriefs (development)" }).click();
  await expect(page.getByText(/Loaded 2 test debriefs, with 7 proposals to review\./)).toBeVisible(
    cold,
  );
  if (options.finishing) {
    await page.getByRole("button", { name: "Load a finishing debrief (development)" }).click();
    await expect(page.getByText(/Loaded a debrief that's still finishing/)).toBeVisible(cold);
  }
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible(cold);
  await expect(cards(page)).toHaveCount(7, cold);
  await hydrated(page);
}

/**
 * Waits until the inbox has hydrated. The server's HTML shows every card before then, but a click
 * on it does nothing, which a slow runner under next dev can make last seconds. The debriefs' times
 * are the signal: the server writes them in UTC and says so ("Nov 16, 3:00 pm UTC"), and the page
 * swaps in the reviewer's own words as it hydrates (`When`). So call it once cards show.
 */
export async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("time").filter({ hasText: / UTC$/ })).toHaveCount(0, {
    timeout: 60_000,
  });
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
