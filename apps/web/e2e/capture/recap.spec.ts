import { expect, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { LINES, openFakeCapture, sayWithSpace, transcript, waitUntilReady } from "./support";

// The recap on the capture screen (Phase 5 spec WP10 step 8): once the debrief ends, SessionDO
// writes it after `session.ended` (the e2e Worker's scripted recap model answers, quoting what was
// said), and the screen shows it under "Debrief ended": the headline first, each sentence opening
// the words it quotes, the lens collapsed. Axe in both themes. No keys, no providers.
test.setTimeout(180_000);

for (const colorScheme of ["light", "dark"] as const) {
  test(`the recap appears once the debrief ends, each sentence opens its words, and it passes axe (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    // The device's lens, as Settings → Capture keeps it.
    await page.addInitScript(() =>
      window.localStorage.setItem("earshot.capture.recap-lens", "meddic"),
    );
    const start = await openFakeCapture(page);
    await start.click();
    await waitUntilReady(page);
    await sayWithSpace(page);
    await sayWithSpace(page);
    await expect(transcript(page).locator("p")).toHaveCount(2, { timeout: 20_000 });

    await page.keyboard.press("Escape");
    const ended = page.getByRole("region", { name: "Debrief ended" });
    await expect(ended).toBeVisible({ timeout: 20_000 });
    const recap = ended.getByRole("region", { name: "Recap" });
    await expect(recap).toBeVisible({ timeout: 30_000 });
    // Nothing on the capture screen speaks on its own but the transcript.
    await expect(page.locator("main [aria-live]")).toHaveCount(1);

    // The headline quotes the first thing said; opening it shows those words.
    const firstSentence = LINES[0].split(". ")[0] ?? "";
    const headline = recap.getByRole("button", { name: `${firstSentence}.` });
    await expect(headline).toHaveAttribute("aria-expanded", "false");
    await headline.click();
    await expect(headline).toHaveAttribute("aria-expanded", "true");
    const heard = recap.locator("[data-slot=recap-heard]").first();
    await expect(heard).toContainText(`Heard: “${firstSentence}”`);
    // This device kept the turn's audio (evidence clips are on by default, Phase 5 WP9), so the
    // sentence's words can be played, as a card's can.
    await expect(
      heard.getByRole("button", { name: /^Play what you said, \d+ seconds?$/ }),
    ).toBeVisible();

    // The lens sits collapsed beneath: "MEDDIC: n of 6 mentioned".
    const lens = recap.getByRole("button", { name: /^MEDDIC: \d of 6 mentioned$/ });
    await expect(lens).toHaveAttribute("aria-expanded", "false");
    await lens.press("Enter");
    await expect(lens).toHaveAttribute("aria-expanded", "true");
    await expect(recap.getByText("Economic buyer")).toBeVisible();
    await expect(recap.getByText("Not mentioned").first()).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
}
