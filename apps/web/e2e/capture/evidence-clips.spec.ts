import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { signInAsNewUser } from "../support/sign-in";
import { openFakeCapture, proposalCards, sayWithSpace, waitUntilReady } from "./support";

// Evidence clips (Phase 5 spec WP9; ADR-0036) with Chrome's fake microphone: the capture screen says
// once that clips are on; a turn's audio is kept in this browser's IndexedDB, encrypted under a key
// JavaScript can't read; the tray's card gets a play button named for what it plays, which plays
// the words and says so once; no request or socket frame carries the audio; and signing out
// deletes every clip and the key.
test.setTimeout(180_000);

/** What `earshot-evidence` holds, read without creating it: null when the database doesn't exist. */
async function evidenceStore(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((db) => db.name);
    if (!names.includes("earshot-evidence")) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("earshot-evidence");
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const read = (store: string, all: boolean) =>
      new Promise<unknown>((resolve, reject) => {
        const objects = db.transaction(store, "readonly").objectStore(store);
        const request = all ? objects.getAll() : objects.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const clips = (await read("clips", true)) as {
      id: string;
      sessionId: string;
      turnId: string;
      sampleRate: number;
      codec: string;
      iv: Uint8Array;
      data: ArrayBuffer;
      createdAt: number;
      expiresAt: number;
    }[];
    const keys = (await read("device", true)) as CryptoKey[];
    db.close();
    return {
      clips: clips.map((clip) => ({
        idIsSlot: clip.id === `${clip.sessionId}:${clip.turnId}`,
        sampleRate: clip.sampleRate,
        codec: clip.codec,
        ivBytes: clip.iv.byteLength,
        dataBytes: clip.data.byteLength,
        lifetimeMs: clip.expiresAt - clip.createdAt,
      })),
      keys: keys.map((key) => ({ extractable: key.extractable, algorithm: key.algorithm.name })),
    };
  });
}

test("a turn's audio stays on this device: the tray plays it, nothing uploads it, and sign-out deletes it", async ({
  page,
}) => {
  // Every body the page sends: requests, and the session socket's frames.
  const sent: { what: string; bytes: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET") return;
    sent.push({
      what: `${request.method()} ${new URL(request.url()).pathname}`,
      bytes: request.postDataBuffer()?.byteLength ?? 0,
    });
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      const { payload } = frame;
      sent.push({
        what: `frame ${new URL(socket.url()).pathname}`,
        bytes: typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength,
      });
    });
  });

  const start = await openFakeCapture(page);
  // The one-time notice, before the first debrief.
  const notice = page.locator("[data-slot=clips-notice]");
  await expect(notice).toContainText("Evidence clips are on");
  await expect(notice).toContainText(
    "Keeps what you say on this device for 24 hours so you can replay it while reviewing. Never uploaded.",
  );
  await expect(notice.getByRole("link", { name: "Settings → Capture" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await start.click();
  await waitUntilReady(page);
  // Starting with the notice on screen counts as seeing it.
  await expect(notice).toHaveCount(0);

  await sayWithSpace(page);
  const card = proposalCards(page).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const play = card.getByRole("button", { name: /^Play what you said, \d+ seconds?$/ }).first();
  await expect(play).toBeVisible({ timeout: 20_000 });
  await expect(play).not.toHaveAttribute("aria-keyshortcuts");
  await expect(card.locator("[data-slot=no-audio]")).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);

  // The turn is in IndexedDB as the spec's record, encrypted under a key that can't be read out.
  const kept = await evidenceStore(page);
  expect(kept?.keys).toEqual([{ extractable: false, algorithm: "AES-GCM" }]);
  expect(kept?.clips).toHaveLength(1);
  const [clip] = kept?.clips ?? [];
  expect(clip).toMatchObject({
    idIsSlot: true,
    sampleRate: 16_000,
    codec: "pcm16",
    ivBytes: 12,
    lifetimeMs: 24 * 60 * 60 * 1000,
  });
  // PCM16 at 16 kHz, from the press to the release and its 200 ms tail, plus the GCM tag.
  const audioBytes = (clip?.dataBytes ?? 0) - 16;
  expect(audioBytes).toBeGreaterThanOrEqual(1_800 * 32);

  // Pressing it plays the words, and the page says so once, not again while they play.
  const status = page.locator("[data-slot=clip-status]");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("main [data-slot=clip-status]")).toHaveCount(0);
  await status.evaluate((element) => {
    const said: string[] = [];
    (window as unknown as { __clipStatus: string[] }).__clipStatus = said;
    new MutationObserver(() => {
      const text = element.textContent ?? "";
      if (text !== "") said.push(text);
    }).observe(element, { childList: true, subtree: true, characterData: true });
  });
  await play.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __clipStatus: string[] }).__clipStatus))
    .toEqual(["Playing what you said."]);
  // The span is a second or two: once it ends, the line goes quiet, and nothing more was said.
  await expect(status).toHaveText("", { timeout: 10_000 });
  await expect(play).not.toHaveAttribute("data-playing");
  expect(
    await page.evaluate(() => (window as unknown as { __clipStatus: string[] }).__clipStatus),
  ).toEqual(["Playing what you said."]);
  await expect(play).toBeFocused();

  // By keyboard: Enter plays it again, said once more; Space does too, and starts no turn, since
  // push-to-talk leaves Space to a focused button.
  for (const [key, times] of [
    ["Enter", 2],
    ["Space", 3],
  ] as const) {
    await page.keyboard.press(key);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __clipStatus: string[] }).__clipStatus.length),
      )
      .toBe(times);
    await expect(status).toHaveText("", { timeout: 10_000 });
  }
  await expect(page.locator("[data-slot=capture-status]")).toHaveText("Ready: hold to talk");
  await expect(proposalCards(page)).toHaveCount(1);

  // Nothing the page sent could hold the audio: every body is under a second of it, let alone
  // the turn's, and no write goes to anything named for clips.
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) {
    expect(body.bytes, body.what).toBeLessThan(32_000);
    expect(body.what).not.toMatch(/clip|evidence/i);
  }

  // Sign out from the account menu: every clip goes, and the key with them.
  await page.getByRole("button", { name: /^Account menu for / }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/, { timeout: 30_000 });
  expect(await evidenceStore(page)).toEqual({ clips: [], keys: [] });
});

test("turning clips off in Settings → Capture deletes the clip kept, and the card says clips are off", async ({
  page,
}) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);
  await sayWithSpace(page);
  const card = proposalCards(page).first();
  await expect(card.getByRole("button", { name: /^Play what you said/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  expect((await evidenceStore(page))?.clips).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 20_000,
  });

  // To Settings → Capture by the app's own links, so the ended debrief's tray is still there after.
  await page.getByRole("button", { name: /^Account menu for / }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  // next dev compiles each settings page on its first visit.
  const settings = page.getByRole("navigation", { name: "Settings" });
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible({
    timeout: 60_000,
  });
  await settings.getByRole("link", { name: "Capture" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible({
    timeout: 60_000,
  });
  const clips = page.getByRole("switch", { name: "Evidence clips" });
  await expect(clips).toBeChecked();
  await expect(clips).toHaveAccessibleDescription(
    /Keeps what you say on this device for 24 hours so you can replay it while reviewing\. Never uploaded\./,
  );
  expect(await seriousViolations(page)).toEqual([]);

  // Off: nothing more is kept, and what was kept is deleted, with its key.
  await clips.click();
  await expect(clips).not.toBeChecked();
  await expect(
    page.getByText("Saved on this device: evidence clips off, and the clips here deleted."),
  ).toBeVisible();
  expect(await evidenceStore(page)).toEqual({ clips: [], keys: [] });

  // The tray's card says why it has no audio now, and links to the switch.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Capture" })
    .click();
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 60_000,
  });
  const line = proposalCards(page).first().locator("[data-slot=no-audio]");
  await expect(line).toHaveText("Evidence clips are off. Turn them on in Settings → Capture.");
  await expect(line.getByRole("link", { name: "Settings → Capture" })).toHaveAttribute(
    "href",
    "/settings/capture",
  );
  await expect(
    proposalCards(page).getByRole("button", { name: /^Play what you said/ }),
  ).toHaveCount(0);

  // On again: the browser is asked once to keep the site's storage, through WP3b's flag.
  await line.getByRole("link", { name: "Settings → Capture" }).click();
  await expect(clips).not.toBeChecked();
  await clips.click();
  await expect(clips).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("earshot.persist.v1")))
    .not.toBeNull();
});

// The automated security review of #62: the clips belong to the user who kept them. A session that
// ends without the menu's sign-out (it expired, or was signed out from another device) leaves them
// in this browser, so the next user to open Earshot here clears them before anything is kept.
test("the next user to sign in on this browser never inherits the last one's clips", async ({
  page,
}) => {
  const start = await openFakeCapture(page);
  await start.click();
  await waitUntilReady(page);
  await sayWithSpace(page);
  const card = proposalCards(page).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("button", { name: /^Play what you said/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(async () => (await evidenceStore(page))?.clips.length ?? 0).toBeGreaterThan(0);

  // The session ends without the menu's sign-out: its cookies go, as when it expires.
  await page.context().clearCookies();
  // Another user signs in on this browser, and the app opens for them.
  await signInAsNewUser(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect.poll(() => evidenceStore(page)).toEqual({ clips: [], keys: [] });
});
