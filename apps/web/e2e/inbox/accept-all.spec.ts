import { expect, type Locator, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import {
  CARDS,
  card,
  cards,
  expectFocusOffBody,
  focused,
  hydrated,
  openInboxWithSamples,
  reviewsSent,
  settled,
} from "./support";

// "Accept all from this call" (Phase 5 spec WP6 step 1; ADR-0035), over the sample debriefs, which
// hold a card in every tier: Pier Logistics' question (loud), its deal update linked in context
// (the name note), and its task on the open account (a quiet card note); Acme Dynamics' three
// unmarked cards and its note on the open account. The batch takes Acme's three alone, the
// checkpoint says what stays and why, one undo (u, the toast's, or Reviewed's) restores the batch
// with focus on its first card, and the checkpoint passes axe in both themes.
test.setTimeout(240_000);

interface PostedReview {
  readonly reviewId: string;
  readonly proposalId: string;
  readonly decision: string;
  readonly mode: string;
  readonly batchId: string | null;
  readonly undoes: string | null;
  readonly input: string;
  readonly surface: string;
  readonly seen: { readonly tier: string };
  readonly timing: { readonly decisionMs: number; readonly handlingMs: number };
}

/** Every review the page posts to the review route, in order. */
function recordReviews(page: Page): PostedReview[] {
  const posted: PostedReview[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/api\/sessions\/[^/]+\/reviews$/.test(request.url())) {
      return;
    }
    const body = request.postDataJSON() as { reviews?: PostedReview[] };
    posted.push(...(body.reviews ?? []));
  });
  return posted;
}

function group(page: Page, account: string): Locator {
  return page
    .locator("[data-slot=session-group]")
    .filter({ has: page.getByRole("heading", { level: 3, name: new RegExp(`^${account} · `) }) });
}

/** axe in both themes, leaving the page in the light one. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const BATCH = [CARDS.danaLee, CARDS.acmeStage, CARDS.seanTask] as const;
const STAYING = [CARDS.dana, CARDS.pierAmount, CARDS.pierTask, CARDS.acmeNote] as const;

test("accept all: the checkpoint says what stays, the batch takes only unmarked cards, and one undo brings it back", async ({
  page,
}) => {
  const posted = recordReviews(page);
  await openInboxWithSamples(page);
  const toast = page.getByRole("region", { name: "Notifications" });
  const inboxLink = (count: number) =>
    page.getByRole("navigation", { name: "Main" }).getByRole("link", {
      name: `Inbox, ${count} to review`,
    });
  await expect(inboxLink(7)).toBeVisible();

  // Pier Logistics: every card is marked (a question, a name note, a quiet note), so its button is
  // disabled, still reachable, and says why.
  const pierAll = group(page, "Pier Logistics").getByRole("button", {
    name: "Accept all unmarked",
  });
  await expect(pierAll).toHaveAttribute("aria-disabled", "true");
  await expect(pierAll).toHaveAccessibleDescription(
    "Every card here is marked, so each needs a look.",
  );
  // Reachable by keyboard, and Enter on it does nothing.
  await pierAll.focus();
  await expect(pierAll).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Accept all from this call" })).toHaveCount(0);

  // Acme Dynamics: three unmarked cards. The checkpoint opens inline, focus on its confirm button,
  // whose description says what happens.
  const acmeAll = group(page, "Acme Dynamics").getByRole("button", { name: "Accept 3 unmarked" });
  await expect(acmeAll).toHaveAttribute("aria-expanded", "false");
  await acmeAll.click();
  const checkpoint = page.getByRole("group", { name: "Accept all from this call" });
  const confirm = checkpoint.getByRole("button", { name: "Accept 3" });
  await expect(confirm).toBeFocused();
  await expect(acmeAll).toHaveAttribute("aria-expanded", "true");
  await expect(confirm).toHaveAccessibleDescription("3 will be accepted. 1 stays for review.");
  await expect(
    checkpoint.getByRole("list", { name: "Will be accepted (3)" }).getByRole("listitem"),
  ).toHaveText([
    /^Contact · Dana Lee/,
    /^Deal update · Acme Dynamics - Expansion/,
    /^Task · Sean Murphy/,
  ]);
  // What stays, and why: the debrief's note, on the open account.
  await expect(
    checkpoint.getByRole("list", { name: "Stays for review (1)" }).getByRole("listitem"),
  ).toHaveText([/^Note · Acme Dynamics.*Has a note: Open account assumed$/]);
  await expectNoViolations(page, "the checkpoint");

  // The list's single keys don't act from inside the checkpoint; Esc closes it, back on the button.
  for (const key of ["a", "r", "j", "u", "1"]) await page.keyboard.press(key);
  await expect(cards(page)).toHaveCount(7);
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(checkpoint).toHaveCount(0);
  await expect(acmeAll).toBeFocused();

  // Enter opens it again, and Enter confirms: the three leave together, focus goes to the first
  // card the batch left in its group, and one polite message says what happened.
  await page.keyboard.press("Enter");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cards(page)).toHaveCount(4);
  for (const name of BATCH) await expect(card(page, name)).toHaveCount(0);
  for (const name of STAYING) await expect(card(page, name)).toBeVisible();
  await expect.poll(() => focused(page)).toBe(CARDS.acmeNote);
  await expect(toast).toContainText("Accepted 3. 1 stays for review. Press U to undo.");
  const reviewed = page.getByRole("region", { name: "Reviewed" });
  await expect(reviewed.getByRole("listitem")).toHaveCount(1);
  await expect(
    reviewed.getByRole("button", { name: "Undo: accepted together, 3 proposals" }),
  ).toBeVisible();
  await expect(inboxLink(4)).toBeVisible();

  // The route got one batch: three approvals with one batch id and the batch's own time, by
  // keyboard, in the inbox, and none of the marked cards.
  await reviewsSent(page);
  const batch = posted.filter(
    (review) => review.mode === "batch" && review.decision === "approved",
  );
  expect(batch).toHaveLength(3);
  expect(new Set(batch.map((review) => review.batchId)).size).toBe(1);
  for (const review of batch) {
    expect(review).toMatchObject({ input: "keyboard", surface: "inbox", seen: { tier: "none" } });
    expect(review.timing).toEqual(batch[0]?.timing);
  }

  // One u undoes the whole batch, each card's reopen naming its own review; focus on its first card.
  await page.keyboard.press("u");
  await expect(cards(page)).toHaveCount(7);
  await expect.poll(() => focused(page)).toBe(CARDS.danaLee);
  await expect(toast).toContainText("Back for review: 3 proposals. 7 left.");
  await expect(page.getByRole("region", { name: "Reviewed" })).toHaveCount(0);
  await expect(inboxLink(7)).toBeVisible();
  await reviewsSent(page);
  const reopens = posted.filter((review) => review.decision === "reopened");
  expect(reopens.map((review) => review.undoes).sort()).toEqual(
    batch.map((review) => review.reviewId).sort(),
  );
  expect(new Set(reopens.map((review) => review.batchId))).toEqual(new Set([batch[0]?.batchId]));

  // The toast's Undo does the same, its state read when it's pressed. A replaced toast lingers a
  // moment as it animates out, Undo and all, so wait for the one that's current.
  await acmeAll.click();
  await checkpoint.getByRole("button", { name: "Accept 3" }).click();
  await expect(cards(page)).toHaveCount(4);
  await expect.poll(() => focused(page)).toBe(CARDS.acmeNote);
  await expect(toast.getByRole("dialog")).toHaveCount(1);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(cards(page)).toHaveCount(7);
  await expect.poll(() => focused(page)).toBe(CARDS.danaLee);
  await reviewsSent(page);

  // Once more, and the home page counts what's left, from the same query as the header.
  await acmeAll.click();
  await checkpoint.getByRole("button", { name: "Accept 3" }).click();
  await expect(cards(page)).toHaveCount(4);
  await reviewsSent(page);
  await page.goto("/home");
  await expect(page.locator("[data-slot=review-count]")).toHaveText(
    "4 proposals wait for your review.",
  );
  await expect(inboxLink(4)).toBeVisible();

  // After a reload, Reviewed's one row undoes the batch it read from the log.
  await page.goto("/inbox");
  await expect(cards(page)).toHaveCount(4, { timeout: 60_000 });
  await hydrated(page);
  await page
    .getByRole("region", { name: "Reviewed" })
    .getByRole("button", { name: "Undo: accepted together, 3 proposals" })
    .click();
  await expect(cards(page)).toHaveCount(7);
  await expect.poll(() => focused(page)).toBe(CARDS.danaLee);
  await expectFocusOffBody(page);
  await reviewsSent(page);
  await expect(page.getByText(/Couldn't/)).toHaveCount(0);
  await page.reload();
  await expect(cards(page)).toHaveCount(7, { timeout: 60_000 });
  await expect(page.getByRole("region", { name: "Reviewed" })).toHaveCount(0);
});
