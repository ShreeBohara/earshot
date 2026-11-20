import { readFileSync, writeFileSync } from "node:fs";
import { analyzePilot, PilotResults } from "@earshot/evals/pilot";
import { expect, type Page, test } from "@playwright/test";
import { expectFocusOffBody, settled } from "../inbox/support";
import { seriousViolations } from "../support/axe";
import {
  decideFocused,
  focusedCard,
  MANIFEST,
  openPilot,
  type Seen,
  watchNetwork,
} from "./support";

// The pilot page (Phase 5 spec WP7 step 2; ADR-0039), as a participant meets it: consent first,
// with nothing kept before "I agree"; the practice and the 40 cards on the inbox's card and keys,
// the first card focused as each starts; progress that survives a reload; the results file with
// §4.8's fields and nothing else, which pilot:analyze reads; axe in both themes; and a page that
// requests nothing but static files: no API route, no server action, no write.
test.setTimeout(240_000);

const ORIGIN = new URL(process.env.BASE_URL ?? "http://localhost:3100").origin;

/** axe in both themes, once the page has stopped moving, leaving it in the light one. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * The network check: every request a GET for the page itself or a static file of the build (its
 * scripts, styles, fonts, and icon), on the page's own origin. No fetch or XHR to anything, so no
 * API route, no server action (a POST), and nothing sent anywhere. Two things are `next dev`'s
 * own and absent from the built page: its hot-reload socket, the only socket allowed, and the
 * font files it serves from `/__nextjs_font/` until they're in `/_next/static/media/`.
 */
function expectOnlyStaticFiles(requests: readonly Seen[], sockets: readonly string[]): void {
  const problems = requests.filter((request) => {
    const url = new URL(request.url);
    if (url.protocol === "blob:" || url.protocol === "data:") return false;
    if (request.method !== "GET" || url.origin !== ORIGIN) return true;
    if (request.type === "document") return url.pathname !== "/pilot";
    if (!["script", "stylesheet", "font", "image"].includes(request.type)) return true;
    const devFont = request.type === "font" && url.pathname.startsWith("/__nextjs_font/");
    return !(
      url.pathname.startsWith("/_next/static/") ||
      url.pathname === "/favicon.ico" ||
      devFont
    );
  });
  expect(problems, "requests other than the page and its static files").toEqual([]);
  expect(requests.some((request) => request.type === "document")).toBe(true);
  for (const socket of sockets) {
    expect(["/_next/hmr", "/_next/webpack-hmr"]).toContain(new URL(socket).pathname);
  }
}

async function storage(page: Page): Promise<{ session: string[]; local: string[] }> {
  return page.evaluate(() => ({
    session: Object.keys(window.sessionStorage),
    local: Object.keys(window.localStorage),
  }));
}

test("consent first: the page asks for a number, keeps nothing before I agree, then practices on a focused card", async ({
  page,
}) => {
  test.skip(Boolean(process.env.BASE_URL), "Runs against the local dev server.");
  await page.goto("/pilot");
  await expect(page.getByText("This page needs a participant number.")).toBeVisible({
    timeout: 60_000,
  });

  await openPilot(page, "2");
  await expect(
    page.getByRole("heading", { level: 1, name: "The review pilot: consent" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "What's logged" })).toBeVisible();
  await expect(page.getByText(/You don't speak, no voice is processed/)).toBeVisible();
  // Nothing kept before "I agree": not progress, not anything else.
  expect(await storage(page)).toEqual({ session: [], local: [] });
  await expectNoViolations(page, "consent");

  await page.getByRole("button", { name: "I agree" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Practice" })).toBeVisible();
  expect((await storage(page)).session).toEqual(["earshot.pilot.P2"]);
  // The first card holds focus as the practice starts, so the keys work without a click.
  await expect.poll(() => focusedCard(page)).toBe(MANIFEST.practice.proposals[0]);
  await expect(page.locator("[data-inbox-card]")).toHaveCount(3);
  // Every card says there's no audio.
  await expect(page.locator("[data-slot=no-audio]")).toHaveCount(3);
  await expectNoViolations(page, "practice");

  // The shortcuts dialog, as the inbox's, but sending no one to Settings.
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Inbox keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await expectNoViolations(page, "the shortcuts dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A stray d doesn't flip the theme or write it down.
  await page.keyboard.press("d");
  expect((await storage(page)).local).toEqual([]);
});

test("a participant's run, by keyboard to the download: the file holds §4.8's fields, pilot:analyze reads it, and only static files were requested", async ({
  page,
}, testInfo) => {
  const network = watchNetwork(page);
  await openPilot(page, "1");
  await page.getByRole("button", { name: "I agree" }).focus();
  await page.keyboard.press("Enter");

  // Practice: three cards, each decided from the keyboard, focus moving on by itself.
  await expect(page.getByRole("heading", { level: 1, name: "Practice" })).toBeVisible();
  await expect.poll(() => focusedCard(page)).not.toBeNull();
  for (let i = 0; i < MANIFEST.practice.proposals.length; i++) await decideFocused(page);
  // The next step is one Tab from "All caught up".
  await expect(page.getByRole("heading", { name: "All caught up", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Start the 40 cards" })).toBeFocused();
  await page.keyboard.press("Enter");

  // The 40, in P1's order, the first card focused.
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();
  const order = MANIFEST.orders["1"];
  const firstSession = MANIFEST.sessions.find((session) => session.id === order[0]);
  await expect.poll(() => focusedCard(page)).toBe(firstSession?.proposals[0]);
  const headings = page.locator("[data-slot=session-group] h3");
  await expect(headings.first()).toContainText("Debrief 1 of 10");
  await expect(page.locator("[data-slot=no-audio]")).toHaveCount(40);
  await expectNoViolations(page, "the 40 cards");

  // Two cards, then a reload: the place is kept, and the next card takes focus.
  await decideFocused(page);
  await decideFocused(page);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-inbox-card]")).toHaveCount(38);
  await expect.poll(() => focusedCard(page)).not.toBeNull();

  for (let left = 38; left > 0; left--) {
    await decideFocused(page);
    await expectFocusOffBody(page);
  }
  await expect(page.getByRole("heading", { name: "All caught up", exact: true })).toBeFocused();
  await expectNoViolations(page, "all caught up");

  // The download, by keyboard: one Tab from "All caught up".
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Download results" })).toBeFocused();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Enter"),
  ]);
  expect(download.suggestedFilename()).toMatch(/^earshot-pilot-P1-\d{4}-\d{2}-\d{2}\.json$/);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved earshot-pilot-P1-" }),
  ).toBeVisible();

  const text = readFileSync(file, "utf8");
  const json = JSON.parse(text) as Record<string, unknown>;
  // §4.8's fields and nothing else: no name, user agent, screen size, or address.
  expect(Object.keys(json)).toEqual([
    "format",
    "set",
    "setSha256",
    "participant",
    "order",
    "startedAt",
    "finishedAt",
    "browser",
    "reviews",
    "practice",
  ]);
  const results = PilotResults.parse(json);
  expect(results).toMatchObject({
    set: "pilot.v1",
    setSha256: MANIFEST.sha256,
    participant: "P1",
    order,
    browser: { engine: "blink", mobile: false },
  });
  expect(results.practice).toHaveLength(3);
  expect(results.reviews).toHaveLength(40);
  expect(results.reviews.every((review) => review.input === "keyboard")).toBe(true);
  expect(text).not.toContain("Mozilla");

  // pilot:analyze reads it: 40 decisions, every seeded error caught by its right answer.
  const analysis = analyzePilot([{ name: download.suggestedFilename(), text }], MANIFEST);
  expect(analysis.rejected).toEqual([]);
  const [p1] = analysis.participants;
  expect(p1?.decisions).toBe(40);
  expect(p1?.catches.filter((c) => c.caught)).toHaveLength(8);
  expect(p1?.orderMatches).toBe(true);
  await testInfo.attach("results", { path: file, contentType: "application/json" });

  const seen = testInfo.outputPath("requests.json");
  writeFileSync(seen, `${JSON.stringify(network, null, 2)}\n`);
  await testInfo.attach("requests", { path: seen, contentType: "application/json" });
  expectOnlyStaticFiles(network.requests, network.sockets);
});

test("accept all and undo on the pilot page: one batch, its own time, written to the results", async ({
  page,
}) => {
  await openPilot(page, "ci");
  await page.getByRole("button", { name: "I agree" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Practice" })).toBeVisible();
  for (let i = 0; i < MANIFEST.practice.proposals.length; i++) await decideFocused(page);
  await page.getByRole("button", { name: "Start the 40 cards" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();

  // The first debrief with anything unmarked: its checkpoint, axe, then one batch.
  const enabled = page.locator("[data-slot=accept-all]:not([aria-disabled=true])").first();
  await expect(enabled).toBeVisible();
  await enabled.click();
  const checkpoint = page.locator("[data-inbox-checkpoint]");
  await expect(checkpoint).toBeVisible();
  await expectNoViolations(page, "the checkpoint");
  const before = await page.locator("[data-inbox-card]").count();
  await checkpoint.getByRole("button", { name: /^Accept \d+$/ }).click();
  await expect(page.locator("[data-inbox-card]")).not.toHaveCount(before);
  const taken = before - (await page.locator("[data-inbox-card]").count());
  expect(taken).toBeGreaterThan(0);
  await expectFocusOffBody(page);

  // One u undoes the whole batch.
  await page.keyboard.press("u");
  await expect(page.locator("[data-inbox-card]")).toHaveCount(before);

  const stored = await page.evaluate(() => window.sessionStorage.getItem("earshot.pilot.ci"));
  const progress = JSON.parse(stored ?? "{}") as {
    events: { type: string; payload: { mode: string; decision: string; batchId: string } }[];
  };
  const batch = progress.events.filter((event) => event.payload.mode === "batch");
  expect(batch).toHaveLength(2 * taken);
  expect(new Set(batch.map((event) => event.payload.batchId)).size).toBe(1);
  expect(batch.filter((event) => event.payload.decision === "reopened")).toHaveLength(taken);
});
