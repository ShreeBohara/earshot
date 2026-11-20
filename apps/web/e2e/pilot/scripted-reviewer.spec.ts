import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { companies, contacts, deals } from "@earshot/demo-crm";
import {
  analyzePilot,
  checkKlm,
  countWords,
  type Decision,
  type DecisionKind,
  flagFollowerBound,
  KLM_BASELINE_PATH,
  KlmBaseline,
  type KlmCard,
  klmBaseline,
  klmBaselineText,
  klmMedianMs,
  klmMs,
  klmSteps,
  overBudget,
  PilotResults,
  pilotOracle,
  reviewerMarkdown,
} from "@earshot/evals/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectFocusOffBody, focused } from "../inbox/support";
import {
  expectNoViolations,
  expectOnlyStaticFiles,
  focusedCard,
  MANIFEST,
  openPilot,
  watchNetwork,
} from "./support";

// The scripted reviewer (Phase 5 spec WP8, gates G1a and G2a; ADR-0039): /pilot?p=ci by keyboard
// on a fake clock, the pilot's own path at $0, with an oracle from pilot.v1's manifest, never from
// the page. Flagged errors are answered "New" (its digit, on the focused card: focus moves on by
// itself after each decision, so no j), silent ones fixed with c and the right record's digit, and
// the rest accepted by key. It checks what later packages mustn't break:
//
// - every card shows the markers the manifest built it with, read as a reviewer meets them: in the
//   accessibility tree (a loud card's description says it "needs a check"; a name note is part of
//   the card's name) and on screen. So every flagged error is loud and every silent one carries
//   "matched by sound";
// - at most 2 keys to accept, reject, or choose in a question, and 3 to choose another record for
//   a link, every key counted;
// - focus never on <body> after any key;
// - the KLM estimate per card (packages/evals/src/pilot/klm.ts): no card more than 10% above
//   baselines/pilot-klm.json, and the median at most 4.0 s or, while the set misses that, at most
//   the baseline's. The reviewer spends each card's estimate on the paused fake clock, so the
//   page's own review clock records it, and pilot:analyze on the run's results file gives the same
//   median;
// - the flag-follower bound, in the report: 4 of 8;
// - and no network beyond the static page.
//
// The second test walks the same path, spending the same time on each card, and runs axe in every
// state it reaches, in both themes. axe-core settles each rule through setTimeout, which a paused
// clock fires only as the reviewer spends time, so that walk's clock flows. It leaves the markers
// to the first, so a lost marker fails one test.
//
// Record the KLM baseline on purpose, from the committed set: `CI=1 EARSHOT_PILOT_KLM=record pnpm
// --filter @earshot/web exec playwright test e2e/pilot/scripted-reviewer.spec.ts`, then review the
// diff of packages/evals/baselines/pilot-klm.json and commit it.

/** Where the fake clock starts: the same instant every run. */
const START = new Date("2026-11-20T15:00:00.000Z");
const RECORD = process.env.EARSHOT_PILOT_KLM === "record";
const BASELINE_FILE = path.join(import.meta.dirname, "../../../..", KLM_BASELINE_PATH);

const ORACLE = pilotOracle(MANIFEST);
const TIERS = new Map(MANIFEST.tiers.proposals.map((tier) => [tier.proposalId, tier]));
const SESSION_OF = new Map(
  MANIFEST.sessions.flatMap((session) => session.proposals.map((id) => [id, session.id] as const)),
);
/** The demo CRM's records by id, named as the cards name them. */
const NAMES: ReadonlyMap<string, string> = new Map([
  ...companies.map((row) => [row.id, row.name] as const),
  ...contacts.map((row) => [row.id, `${row.firstName} ${row.lastName}`] as const),
  ...deals.map((row) => [row.id, row.name] as const),
]);
/** The name notes, as a card's heading shows them beside the record. */
const NAME_NOTES = { sound: "matched by sound", context: "matched in context" } as const;
const LOUD = /needs a check/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cardLocator(page: Page, proposalId: string): Locator {
  return page.locator(`[data-inbox-card][data-proposal-id="${proposalId}"]`);
}

/**
 * The card's visible text, which `countWords` turns into its words (klm.ts): every text node on
 * screen, but none inside a button, the action toolbar, or a key label (`kbd`), which keys pay for
 * instead. On screen means rendered (`checkVisibility`, opacity and visibility included) and not
 * clipped into a box too small to show it, the way text kept for screen readers alone is hidden.
 */
async function shownText(card: Locator): Promise<string> {
  return card.evaluate((root) => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      let shown = true;
      for (let element: Element | null = parent; element; element = element.parentElement) {
        if (element.matches("button, [role='toolbar'], kbd")) shown = false;
        const box = element.getBoundingClientRect();
        if (box.width <= 1 && box.height <= 1 && getComputedStyle(element).overflow !== "visible") {
          shown = false;
        }
        if (!shown || element === root) break;
      }
      if (shown) parts.push(node.textContent ?? "");
    }
    return parts.join(" ");
  });
}

/** The card's heading as shown: its type and record, with any name note. */
async function headingOf(card: Locator): Promise<string> {
  const text = await card.getByRole("heading").first().textContent();
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The markers the manifest built the card with, as a reviewer meets them: loud in the card's
 * accessible description ("…, needs a check: …") and its "Needs a check" on screen; the name note
 * as the end of the card's accessible name and on screen. A seeded error's marker first, by name:
 * loud for a flagged one, "matched by sound" for a silent one. Soft, so a run where markers vanish
 * names every card that lost one, and goes on to the rest of the gate. True when all of them held.
 */
async function expectMarkers(card: Locator, proposalId: string, shown: string): Promise<boolean> {
  const tier = TIERS.get(proposalId);
  expect(tier, `${proposalId} is in the manifest's tiers`).toBeDefined();
  if (!tier) return false;
  const failedBefore = test.info().errors.length;
  const seeded = ORACLE.get(proposalId);
  const what = `${SESSION_OF.get(proposalId) ?? "practice"} ${proposalId}`;
  if (seeded?.kind === "flagged") {
    await expect.soft(card, `the flagged error ${what} is loud`).toHaveAccessibleDescription(LOUD);
    expect.soft(shown, `the flagged error ${what} says so on screen`).toContain("Needs a check");
  }
  if (seeded?.kind === "silent") {
    await expect
      .soft(card, `the silent error ${what} carries its name note`)
      .toHaveAccessibleName(new RegExp(`, ${NAME_NOTES.sound}$`));
    expect.soft(shown, `the silent error ${what} shows its name note`).toContain(NAME_NOTES.sound);
  }
  if (tier.tier === "loud") {
    await expect.soft(card, `${what} is loud`).toHaveAccessibleDescription(LOUD);
    expect.soft(shown, `${what} says it needs a check`).toContain("Needs a check");
  } else {
    await expect.soft(card, `${what} isn't loud`).not.toHaveAccessibleDescription(LOUD);
  }
  if (tier.nameNote) {
    const note = NAME_NOTES[tier.nameNote];
    await expect.soft(card, `${what}'s name note`).toHaveAccessibleName(new RegExp(`, ${note}$`));
    expect.soft(shown, `${what} shows its name note`).toContain(note);
  } else {
    await expect
      .soft(card, `${what} has no name note`)
      .not.toHaveAccessibleName(/matched (?:by sound|in context)/);
  }
  return test.info().errors.length === failedBefore;
}

/**
 * The page's state, as far as axe could see a difference: the screen, a panel, a toast. A toast
 * already on its way out doesn't count: axe waits for the page to settle, and it's gone by then.
 */
async function stateOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const screen = document.querySelector("main h1")?.textContent?.trim() ?? "?";
    const correction = [...document.querySelectorAll("fieldset legend")].some(
      (legend) => legend.textContent?.trim() === "Correct the record",
    );
    const toasts = document.querySelectorAll(
      "[role='region'][aria-label='Notifications'] [role='dialog']:not([data-ending-style])",
    ).length;
    const caughtUp = [...document.querySelectorAll("h3")].some(
      (heading) => heading.textContent?.trim() === "All caught up",
    );
    const saved = [...document.querySelectorAll("[role='status']")].some((status) =>
      status.textContent?.startsWith("Saved "),
    );
    return [
      screen,
      correction ? "the correction panel" : null,
      toasts > 0 ? "a toast" : null,
      caughtUp ? "all caught up" : null,
      saved ? "results saved" : null,
    ]
      .filter(Boolean)
      .join(", ");
  });
}

interface WalkOptions {
  /** Check every card's markers (the timed walk); the axe walk leaves them to it. */
  readonly markers?: boolean;
  /** Called at each screen, and twice for each key of a decision: on arriving, and at the key. */
  readonly onState?: (where: string) => Promise<void>;
}

interface Walked {
  readonly cards: KlmCard[];
  readonly decisions: Decision[];
  readonly keys: number;
  readonly last: string;
  /** The cards whose markers were checked, and those that lost one. */
  readonly markers: { readonly checked: number; readonly missing: string[] };
  readonly results: { readonly name: string; readonly text: string };
}

/**
 * The scripted reviewer's run, from consent to the results file: the practice and the 40 cards,
 * each decided on the card holding focus, with its estimate spent on the fake clock before its
 * keys (klm.ts's steps: the reading before each key, then K).
 */
async function walk(page: Page, options: WalkOptions = {}): Promise<Walked> {
  const cards: KlmCard[] = [];
  const decisions: Decision[] = [];
  const markers = { checked: 0, missing: [] as string[] };
  let keys = 0;
  const press = async (key: string) => {
    await page.keyboard.press(key);
    keys += 1;
    await expectFocusOffBody(page);
  };

  /** Decides the focused card: the manifest's answer for a seeded error, otherwise accepts it. */
  async function decide(phase: "practice" | "review", n: number): Promise<void> {
    await expect.poll(() => focusedCard(page), { message: "a card holds focus" }).not.toBeNull();
    const id = (await focusedCard(page)) as string;
    const card = cardLocator(page, id);
    const heading = await headingOf(card);
    const session = phase === "practice" ? "practice" : SESSION_OF.get(id);
    expect(session, `${id} is one of the set's cards`).toBeDefined();
    const answer = ORACLE.get(id);
    let decision: DecisionKind;
    let sequence: readonly string[];
    if (answer) {
      decision = answer.decision;
      sequence = answer.keys;
    } else if ((await card.getByRole("radiogroup").count()) > 0) {
      decision = "question";
      sequence = ["1"];
    } else if (heading.includes("· No record")) {
      decision = "reject";
      sequence = ["r"];
    } else {
      decision = "accept";
      sequence = ["a"];
    }
    const loud = TIERS.get(id)?.tier === "loud";
    const words: number[] = [];
    for (const [index, key] of sequence.entries()) {
      const shown = await shownText(card);
      words.push(countWords(shown));
      if (index === 0) {
        if (options.markers) {
          markers.checked += 1;
          if (!(await expectMarkers(card, id, shown)))
            markers.missing.push(`${session} ${heading}`);
        }
        if (answer?.kind === "flagged") {
          const choice = card
            .getByRole("radiogroup", { name: "Which record?" })
            .getByRole("radio")
            .nth(answer.choice);
          await expect(choice, `"New" is choice ${key} on ${id}`).toHaveAccessibleName(
            /A new record/,
          );
        }
      } else if (answer?.kind === "silent") {
        const right = NAMES.get(answer.right) ?? answer.right;
        const choice = card
          .getByRole("group", { name: "Correct the record" })
          .getByRole("radio")
          .nth(answer.choice);
        await expect(choice, `${right} is choice ${key} on ${id}`).toHaveAccessibleName(
          new RegExp(escapeRegExp(right)),
        );
      }
      // The state as the reviewer arrives, and again once the reading is done, as the key goes.
      await options.onState?.(`${phase} card ${n}, reading for ${key}`);
      await page.clock.runFor(klmSteps(loud, words)[index] as number);
      await options.onState?.(`${phase} card ${n}, pressing ${key}`);
      await press(key);
    }
    await expect(card, `${id} leaves once decided`).toHaveCount(0);
    decisions.push({ proposalId: id, decision, keys: [...sequence] });
    if (phase === "review") {
      const tier = TIERS.get(id);
      const shownWords = words.at(-1) ?? 0;
      cards.push({
        session: session as KlmCard["session"],
        proposalId: id,
        heading,
        tier: tier?.tier ?? "none",
        seeded: tier?.seeded ?? null,
        decision,
        keys: [...sequence],
        words: shownWords,
        ms: klmMs({ loud, words: shownWords, keys: sequence.length }),
      });
    }
  }

  await openPilot(page, "ci");
  await options.onState?.("consent");
  await page.getByRole("button", { name: "I agree" }).focus();
  await press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: "Practice" })).toBeVisible();
  for (let n = 1; n <= MANIFEST.practice.proposals.length; n++) await decide("practice", n);
  const caughtUp = page.getByRole("heading", { name: "All caught up", exact: true });
  await expect(caughtUp).toBeFocused();
  await options.onState?.("the practice's end");
  await press("Tab");
  await expect(page.getByRole("button", { name: "Start the 40 cards" })).toBeFocused();
  await press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();
  const total = MANIFEST.sessions.reduce((sum, session) => sum + session.proposals.length, 0);
  for (let n = 1; n <= total; n++) await decide("review", n);
  await expect(caughtUp).toBeFocused();
  const last = await focused(page);
  await options.onState?.("the 40 cards' end");

  await press("Tab");
  await expect(page.getByRole("button", { name: "Download results" })).toBeFocused();
  const [download] = await Promise.all([page.waitForEvent("download"), press("Enter")]);
  const file = await download.path();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved earshot-pilot-ci-" }),
  ).toBeVisible();
  await options.onState?.("the results file saved");
  return {
    cards,
    decisions,
    keys,
    last,
    markers,
    results: { name: download.suggestedFilename(), text: readFileSync(file, "utf8") },
  };
}

function readBaseline(): KlmBaseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  return KlmBaseline.parse(JSON.parse(readFileSync(BASELINE_FILE, "utf8")));
}

test("the scripted reviewer decides pilot.v1 by its oracle on a fake clock: markers, keys per decision, focus, and the KLM estimate against its baseline", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  // Paused from the first script on: time moves only as the reviewer spends it.
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START);
  const network = watchNetwork(page);
  const run = await walk(page, { markers: true });
  // No network beyond the static page: no API route, no server action, nothing sent.
  expectOnlyStaticFiles(network.requests, network.sockets);
  expect(run.cards).toHaveLength(40);
  expect(new Set(run.cards.map((card) => card.proposalId))).toEqual(
    new Set(MANIFEST.sessions.flatMap((session) => session.proposals)),
  );

  // The results file: every seeded error caught by its right answer, and each card's handlingMs
  // the estimate the reviewer spent on it.
  const results = PilotResults.parse(JSON.parse(run.results.text));
  const handling = new Map(
    results.reviews.map((review) => [review.proposalId, review.timing.handlingMs]),
  );
  const exact = run.cards.filter((card) => handling.get(card.proposalId) === card.ms).length;
  const analysis = analyzePilot([run.results], MANIFEST);
  expect(analysis.rejected).toEqual([]);
  const [ci] = analysis.participants;

  let baseline = readBaseline();
  if (RECORD) {
    baseline = klmBaseline(run.cards, MANIFEST, new Date().toISOString().slice(0, 10));
    writeFileSync(BASELINE_FILE, klmBaselineText(baseline));
  }
  const klm = checkKlm(run.cards, baseline, MANIFEST);
  const report = reviewerMarkdown({
    manifest: MANIFEST,
    cards: run.cards,
    klm,
    recorded: RECORD,
    decisions: run.decisions,
    markers: run.markers,
    focus: { keys: run.keys, last: run.last },
    clock: { exact, analyzedMedianMs: ci?.median ?? null },
    attempt: testInfo.retry,
  });
  console.log(`\n${report}\n`);
  await testInfo.attach("scripted-reviewer.md", { body: report, contentType: "text/markdown" });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n\n`);
  if (RECORD) console.log(`Wrote ${KLM_BASELINE_PATH}. Review the diff, then commit it.`);

  expect(run.markers.missing, "cards that lost a marker (each named above)").toEqual([]);
  expect(run.markers.checked).toBe(MANIFEST.practice.proposals.length + run.cards.length);
  expect(overBudget(run.decisions), "decisions over their key budget").toEqual([]);
  expect(klm.problems, "the KLM gate").toEqual([]);
  expect(exact, "cards whose handlingMs is the estimate spent on them").toBe(run.cards.length);
  expect(ci?.decisions).toBe(40);
  expect(ci?.catches.filter((c) => c.caught)).toHaveLength(MANIFEST.seeded.length);
  expect(ci?.median).toBe(klmMedianMs(run.cards));
  // A flag-follower catches only what's loud: the manifest's 4 flagged errors, of 8.
  expect(flagFollowerBound(run.cards)).toEqual({
    caught: MANIFEST.tiers.seeded.loud,
    of: MANIFEST.seeded.length,
  });
  expect(run.last).toBe("All caught up");
});

test("axe in every state the scripted reviewer reaches, in light and dark", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  // The same start and the same time spent on each card, on a clock that flows: axe-core waits on
  // timers, which a paused clock fires only as the reviewer spends time.
  await page.clock.install({ time: START });
  const states: string[] = [];
  await walk(page, {
    onState: async (where) => {
      const state = await stateOf(page);
      if (states.includes(state)) return;
      states.push(state);
      await expectNoViolations(page, `${state} (first reached at ${where})`);
    },
  });
  const list = states.map((state, index) => `${index + 1}. ${state}`).join("\n");
  console.log(`\naxe passed in light and dark in the ${states.length} states reached:\n${list}\n`);
  await testInfo.attach("states.txt", { body: list, contentType: "text/plain" });
  // Consent, the practice, its end, the 40 cards, the correction panel, toasts, the 40's end, and
  // the saved file, at least.
  expect(states.length).toBeGreaterThanOrEqual(6);
});
