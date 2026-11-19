import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { seriousViolations } from "./support/axe";

// /demo is a static page: no account, no key, no edge Worker, no provider. It runs against
// `next dev` or a deployed preview (BASE_URL) alike. Most tests play the recorded session at 8×,
// the speed `?speed=8` adds for tests, which takes about 9 s from start to finish.

test.setTimeout(120_000);

interface FixtureEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const FIXTURE: readonly FixtureEvent[] = readFileSync(
  path.join(import.meta.dirname, "../../../packages/events/fixtures/demo-session.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as FixtureEvent);

const of = (type: string) => FIXTURE.filter((event) => event.type === type);
const UTTERANCES = of("utterance.final").map((event) => ({
  id: String(event.payload.utteranceId),
  text: String(event.payload.text),
}));
const PROPOSALS = of("proposal.created").map((event) => {
  const fields = Object.values(event.payload.fields as Record<string, { evidence: unknown }>);
  const evidence = fields[0]?.evidence as { utteranceId: string } | undefined;
  return { id: String(event.payload.proposalId), quotes: evidence?.utteranceId ?? "" };
});
const STATUS_TEXT: Record<string, string> = {
  approved: "Approved",
  edited: "Edited, then approved",
  rejected: "Rejected",
};
const REVIEWS = of("proposal.reviewed").map((event) => ({
  id: String(event.payload.proposalId),
  status: STATUS_TEXT[String(event.payload.decision)] ?? "",
}));

function status(page: Page): Locator {
  return page.locator("[data-slot=replay-status]");
}

function transcriptLines(page: Page): Locator {
  return page.getByRole("log", { name: "Transcript" }).locator("[data-utterance-id]");
}

function proposalCards(page: Page): Locator {
  return page.getByRole("region", { name: "Proposals" }).getByRole("article");
}

function playButton(page: Page): Locator {
  return page.getByRole("button", { name: /^(Play|Pause)/ });
}

/** Opens /demo and waits until it has hydrated (the controls start disabled in the HTML). */
async function openDemo(page: Page, { testSpeed = true } = {}): Promise<void> {
  await page.goto(testSpeed ? "/demo?speed=8" : "/demo");
  await expect(page.getByRole("heading", { level: 1, name: "A debrief, replayed" })).toBeVisible();
  await expect(playButton(page)).toBeEnabled({ timeout: 30_000 });
  if (testSpeed) {
    await expect(page.getByRole("button", { name: "8×" })).toHaveAttribute("aria-pressed", "true");
  }
}

interface Snapshot {
  readonly lines: string[];
  readonly cards: { id: string; status: string }[];
}

/**
 * Records what the panels show after every DOM change, and every animation that runs on the
 * page's content (or as a View Transition) on every frame, plus the still orb's highest level.
 * At 8× events land 50 ms apart, too close to poll for; the records keep the order exactly.
 */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorded = window as unknown as {
      __snapshots: unknown[];
      __animations: string[];
      __maxLevel: number;
    };
    recorded.__snapshots = [];
    recorded.__animations = [];
    recorded.__maxLevel = 0;
    const snapshot = () => {
      recorded.__snapshots.push({
        lines: Array.from(
          document.querySelectorAll('[role="log"] [data-utterance-id]'),
          (line) => line.getAttribute("data-utterance-id") ?? "",
        ),
        cards: Array.from(document.querySelectorAll("article[data-proposal-id]"), (card) => ({
          id: card.getAttribute("data-proposal-id") ?? "",
          status: card.querySelector("header")?.lastElementChild?.textContent?.trim() ?? "",
        })),
      });
    };
    snapshot();
    new MutationObserver(snapshot).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const sample = () => {
      for (const animation of document.getAnimations()) {
        if (animation.playState !== "running") continue;
        const effect = animation.effect as KeyframeEffect | null;
        const pseudo = effect?.pseudoElement ?? "";
        if (pseudo.startsWith("::view-transition") || effect?.target?.closest("main")) {
          const name =
            (animation as CSSAnimation).animationName ??
            (animation as CSSTransition).transitionProperty ??
            animation.id;
          recorded.__animations.push(`${animation.constructor.name} ${name} ${pseudo}`.trim());
        }
      }
      const level = document.querySelector<HTMLElement>("[data-slot=orb]")?.dataset.level;
      recorded.__maxLevel = Math.max(recorded.__maxLevel, Number(level ?? 0));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function recording(page: Page) {
  return page.evaluate(() => {
    const recorded = window as unknown as {
      __snapshots: Snapshot[];
      __animations: string[];
      __maxLevel: number;
    };
    return {
      snapshots: recorded.__snapshots,
      animations: recorded.__animations,
      maxLevel: recorded.__maxLevel,
    };
  });
}

/** `ids` sorted by when each first showed (ties keep their order): equal to `ids` if in order. */
function byFirstSeen(ids: readonly string[], firstSeen: (id: string) => number): string[] {
  return [...ids].sort((a, b) => firstSeen(a) - firstSeen(b));
}

test("plays at 8×: every line and proposal in order, then the reviews, and nothing leaves the page", async ({
  page,
}) => {
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("websocket", (socket) => sockets.push(socket.url()));

  await openDemo(page);
  await expect(proposalCards(page)).toHaveCount(0);
  await startRecording(page);
  await playButton(page).click();
  await expect(status(page)).toHaveText("Playing the debrief");
  await expect(status(page)).toHaveText("Replay finished", { timeout: 30_000 });

  // The end state: all 7 lines, as said, and all 5 proposals with the reviewer's decisions.
  await expect(transcriptLines(page)).toHaveText(UTTERANCES.map((u) => u.text));
  await expect(proposalCards(page)).toHaveCount(PROPOSALS.length);
  await expect(proposalCards(page).locator("header > :last-child")).toHaveText(
    PROPOSALS.map((p) => REVIEWS.find((r) => r.id === p.id)?.status ?? "Proposed"),
  );
  await expect(page.locator("[data-slot=cost]")).toHaveText("This debrief cost $0.0041");

  const { snapshots } = await recording(page);
  const line = (id: string) => snapshots.findIndex((s) => s.lines.includes(id));
  const card = (id: string) => snapshots.findIndex((s) => s.cards.some((c) => c.id === id));
  const reviewed = (id: string, text: string) =>
    snapshots.findIndex((s) => s.cards.some((c) => c.id === id && c.status === text));

  // Nothing was there before Play, and everything arrived, in the log's order.
  expect(snapshots[0]).toEqual({ lines: [], cards: [] });
  const lineIds = UTTERANCES.map((u) => u.id);
  const cardIds = PROPOSALS.map((p) => p.id);
  expect(lineIds.map(line).every((index) => index > 0)).toBe(true);
  expect(cardIds.map(card).every((index) => index > 0)).toBe(true);
  expect(byFirstSeen(lineIds, line)).toEqual(lineIds);
  expect(byFirstSeen(cardIds, card)).toEqual(cardIds);
  for (const proposal of PROPOSALS) {
    // A card never shows before the line it quotes, and it shows as proposed first.
    expect(card(proposal.id)).toBeGreaterThanOrEqual(line(proposal.quotes));
    const first = snapshots[card(proposal.id)]?.cards.find((c) => c.id === proposal.id);
    expect(first?.status).toBe("Proposed");
  }

  // The reviews come after the debrief, one at a time, in the order they were made.
  const allIn = snapshots.findIndex(
    (s) => s.lines.length === UTTERANCES.length && s.cards.length === PROPOSALS.length,
  );
  const reviewSeen = REVIEWS.map((r) => reviewed(r.id, r.status));
  expect(reviewSeen.every((index) => index > allIn)).toBe(true);
  expect(reviewSeen).toEqual([...reviewSeen].sort((a, b) => a - b));

  // No request left the page's origin (so none reached the edge Worker or a provider), none
  // called the app's own API (sessions, tickets, tokens), and no socket opened but next dev's.
  expect(requests, "the log saw the page itself").toContain(page.url());
  const origin = new URL(page.url()).origin;
  const offOrigin = requests.filter(
    (url) => !url.startsWith("data:") && new URL(url).origin !== origin,
  );
  expect(offOrigin, "requests that left the page's origin").toEqual([]);
  expect(requests.filter((url) => new URL(url).pathname.startsWith("/api/"))).toEqual([]);
  const host = new URL(page.url()).host;
  expect(
    sockets.filter(
      (url) => new URL(url).host !== host || !new URL(url).pathname.startsWith("/_next/"),
    ),
  ).toEqual([]);
});

test("works from the keyboard, and keeps 8× for tests", async ({ page }) => {
  await openDemo(page, { testSpeed: false });
  await expect(page.getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "8×" })).toHaveCount(0);

  // Tab from the top of the page to the play button, as a keyboard-only reader would.
  const play = playButton(page);
  for (let presses = 0; presses < 20; presses++) {
    if (await play.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(play).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Playing the debrief");
  await page.keyboard.press("k");
  await expect(status(page)).toHaveText("Paused");
  await page.keyboard.press("2");
  await expect(page.getByRole("button", { name: "2×" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("End");
  await expect(status(page)).toHaveText("Replay finished");
  await expect(transcriptLines(page)).toHaveCount(UTTERANCES.length);
  await expect(proposalCards(page)).toHaveCount(PROPOSALS.length);
  await expect(play).toBeFocused();
  await expect(play).toHaveAccessibleName(/^Play again/);

  // Home starts over: an empty transcript, playing (at 2×, the first line is 3.6 s away).
  await page.keyboard.press("Home");
  await expect(status(page)).toHaveText("Playing the debrief");
  await expect(transcriptLines(page)).toHaveCount(0);
  await expect(proposalCards(page)).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(status(page)).toHaveText("Paused");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`passes axe before, during, and after playback, and in the whole session (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await openDemo(page);
    expect(await seriousViolations(page)).toEqual([]);

    await playButton(page).click();
    await expect(transcriptLines(page)).toHaveCount(2, { timeout: 30_000 });
    await playButton(page).click();
    await expect(status(page)).toHaveText("Paused");
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole("button", { name: /^Skip to the end/ }).click();
    await expect(status(page)).toHaveText("Replay finished");
    await expect(proposalCards(page)).toHaveCount(PROPOSALS.length);
    expect(await seriousViolations(page)).toEqual([]);

    // Readers who don't want playback get today's static summary.
    await page.getByLabel("Show the whole session").check();
    await expect(page.getByRole("heading", { level: 2, name: "Event log" })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(PROPOSALS.length);
    await expect(page.getByRole("region", { name: "Replay controls" })).toHaveCount(0);
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test("with reduced motion: a still orb that shows the level, and nothing that moves", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await openDemo(page);
  const orb = page.getByRole("img", { name: "Microphone level" });
  await expect(orb).toHaveAttribute("data-renderer", "still");
  await expect(orb).toHaveAttribute("data-animating", "false");

  await startRecording(page);
  await playButton(page).click();
  await expect(status(page)).toHaveText("Replay finished", { timeout: 30_000 });
  await expect(proposalCards(page)).toHaveCount(PROPOSALS.length);

  const { animations, maxLevel } = await recording(page);
  // No card slid in, no View Transition ran, nothing else animated.
  expect(animations).toEqual([]);
  // The ring followed the synthesized microphone level, and settled at 0 at the end.
  expect(maxLevel).toBeGreaterThan(0.2);
  await expect(orb).toHaveAttribute("data-level", "0.00");
  await expect(orb).toHaveAttribute("data-animating", "false");
});
