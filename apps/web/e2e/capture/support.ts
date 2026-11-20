import { expect, type Locator, type Page, test } from "@playwright/test";
import { signInAsNewUser } from "../support/sign-in";

/**
 * Each fake line is spread over 1.2 s of audio from the start of its press
 * (lib/capture/dev/fake-voice.ts); holding a little longer makes sure every word is heard.
 */
export const HOLD_MS = 1_800;

/** The demo session's lines, as the e2e Worker's scenario says them, one per press. */
export const LINES = [
  "Just got out of the meeting with Acme Corp. Met Dana Lee, their new VP of Operations.",
  "She's taking over the evaluation, so she's our main contact now.",
  "They want a revised proposal with the security add-on, so move the deal to the proposal stage.",
] as const;

/**
 * Signs in a new user and opens the capture screen in fake mode, ready to start. `query` adds fake
 * mode's other flags, such as `&script=d003` for an eval debrief.
 */
export async function openFakeCapture(page: Page, query = ""): Promise<Locator> {
  test.skip(Boolean(process.env.BASE_URL), "Fake mode exists only under next dev.");
  await signInAsNewUser(page);
  await page.goto(`/capture?voice=fake${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Debrief" })).toBeVisible();
  await expect(page.getByText("Fake voice (development)")).toBeVisible();
  const start = page.getByRole("button", { name: "Start debrief" });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  return start;
}

export function captureStatus(page: Page): Locator {
  return page.locator("[data-slot=capture-status]");
}

export async function waitUntilReady(page: Page): Promise<void> {
  await expect(captureStatus(page)).toHaveText("Ready: hold to talk", { timeout: 30_000 });
}

export function transcript(page: Page): Locator {
  return page.getByRole("log", { name: "Transcript" });
}

export function proposalCards(page: Page): Locator {
  return page.getByRole("region", { name: "Proposals" }).getByRole("article");
}

/** Holds Space for one line, with focus wherever it is (not in a text field). */
export async function sayWithSpace(page: Page): Promise<void> {
  await page.keyboard.down("Space");
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.up("Space");
}

/** Presses and holds a push-to-talk button with the mouse for one line. */
export async function sayWithPointer(page: Page, button: Locator): Promise<void> {
  const box = await button.boundingBox();
  if (!box) throw new Error("the push-to-talk button isn't on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
}

/** Tabs forward until `target` has focus, as a keyboard-only user would. */
export async function tabTo(page: Page, target: Locator, maxTabs = 40): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`couldn't reach ${target} with ${maxTabs} presses of Tab`);
}
