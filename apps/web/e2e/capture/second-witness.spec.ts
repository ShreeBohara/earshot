import { expect, test } from "@playwright/test";
import { FAKE_WITNESS_GLOBAL, type FakeWitnessScript } from "../../lib/capture/fake";
import { seriousViolations } from "../support/axe";
import {
  openFakeCapture,
  proposalCards,
  sayWithSpace,
  transcript,
  waitUntilReady,
} from "./support";

// next dev compiles each page on first visit, and each line is held in real time.
test.setTimeout(180_000);

// Eval script d003's first line names Atmos Industrial, the account open in Earshot, so the
// linker links it. The scripted second witness mishears it as "Atmo Systems", a company that
// isn't in the CRM: the biased stream could have snapped a new name to the CRM's spelling, so
// SessionDO turns the link into a question and the card shows the conflict (Phase 4 WP9).
const SAID =
  "Debrief from Atmos Industrial. Raj Patel says finance wants to restart the onboarding package they passed on in June.";
const MISHEARD = SAID.replace("Atmos Industrial", "Atmo Systems");

test("a scripted mishearing turns a link into a question, and a conflict pill appears in the tray", async ({
  page,
}) => {
  const script: FakeWitnessScript = { turns: [MISHEARD] };
  await page.addInitScript(
    ({ name, value }) => {
      (globalThis as Record<string, unknown>)[name] = value;
    },
    { name: FAKE_WITNESS_GLOBAL, value: script },
  );
  const start = await openFakeCapture(page, "&script=d003");
  await start.click();
  await waitUntilReady(page);
  await expect(page.locator("[data-slot=witness-status]")).toHaveText(
    "Second witness: fake (development)",
  );

  await sayWithSpace(page);
  // The transcript is the live stream's alone: the witness's words never join it.
  await expect(transcript(page).locator("p")).toHaveText([SAID], { timeout: 20_000 });
  const card = proposalCards(page).first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The witness's conflict: the link became a question, with the old record first and "new".
  await expect(card.getByRole("heading")).toHaveText(
    /^Note · Ask: Atmos Industrial, a new record/,
    {
      timeout: 20_000,
    },
  );
  const pill = card.locator("[data-slot=state-pill][data-state=conflict]");
  await expect(pill).toHaveText("Heard two ways");
  const conflicts = card.getByRole("list", { name: "Where the transcripts disagree" });
  await expect(conflicts).toContainText("Live transcript: “Atmos Industrial”");
  await expect(conflicts).toContainText("Second witness: “Atmo Systems”");
  await expect(card.getByRole("list", { name: "Candidates" })).toContainText("A new record");
  await expect(card.getByRole("list", { name: "Check before approving" })).toContainText(
    "Transcripts disagree on the name",
  );
  await expect(page.locator("[data-slot=witness-status]")).toContainText("1 name heard two ways");
  expect(await seriousViolations(page)).toEqual([]);

  // The next line is heard alike by both: no conflict, and the session ends cleanly.
  await sayWithSpace(page);
  await expect(proposalCards(page)).toHaveCount(2, { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Debrief ended" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-slot=state-pill][data-state=conflict]")).toHaveCount(1);
});
