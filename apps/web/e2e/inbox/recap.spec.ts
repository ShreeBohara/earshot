import { expect, type Page, test } from "@playwright/test";
import { seriousViolations } from "../support/axe";
import { CARDS, card, cards, openInboxWithSamples, settled } from "./support";

// The recap in the inbox (Phase 5 spec WP10 step 8): at the top of its debrief's group, above the
// cards, each sentence opening the words it quotes, and the methodology lens collapsed beneath
// ("MEDDIC: 2 of 6 mentioned"). The test debriefs carry recaps as SessionDO writes them. Axe in
// both themes, collapsed and open.
test.setTimeout(240_000);

async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("each debrief's recap heads its group: sentences open their words, the lens opens its fields", async ({
  page,
}) => {
  await openInboxWithSamples(page);
  const groups = page.locator("[data-slot=session-group]");
  await expect(groups).toHaveCount(2);

  // Pier Logistics (newest): the recap sits above its cards, with no lens.
  const pier = groups.first().getByRole("region", { name: "Recap" });
  await expect(pier).toBeVisible();
  const headline = pier.getByRole("button", {
    name: "The Pier Logistics expansion is worth $112,000, and they're ready to sign.",
  });
  await expect(headline).toBeVisible();
  await expect(pier.getByRole("heading", { name: "Next steps" })).toBeVisible();
  await expect(pier.getByRole("button", { name: /mentioned$/ })).toHaveCount(0);
  const order = await groups
    .first()
    .evaluate((group) =>
      [...group.querySelectorAll("[data-slot=recap], [data-inbox-card]")].map((node) =>
        node.getAttribute("data-slot") === "recap" ? "recap" : "card",
      ),
    );
  expect(order[0]).toBe("recap");
  await expectNoViolations(page, "recaps collapsed");

  // A sentence opens the words it quotes; a second press closes them.
  await headline.click();
  await expect(headline).toHaveAttribute("aria-expanded", "true");
  await expect(pier.locator("[data-slot=recap-heard]")).toHaveText([
    "Heard: “The expansion is worth one hundred twelve thousand”",
    "Heard: “they're ready to sign”",
  ]);

  // Acme Dynamics: one sentence was left out, and MEDDIC sits collapsed.
  const acme = groups.nth(1).getByRole("region", { name: "Recap" });
  await expect(acme.getByText(/1 sentence was left out/)).toBeVisible();
  const lens = acme.getByRole("button", { name: "MEDDIC: 2 of 6 mentioned" });
  await expect(lens).toHaveAttribute("aria-expanded", "false");
  await lens.focus();
  await page.keyboard.press("Enter");
  await expect(lens).toHaveAttribute("aria-expanded", "true");
  await expect(acme.getByText("Identified pain")).toBeVisible();
  await expect(acme.getByText("“onboarding took longer than they hoped”")).toBeVisible();
  await expect(acme.getByText("Not mentioned")).toHaveCount(4);
  await expectNoViolations(page, "a sentence and the lens open");

  // The recap takes no card's place: the seven cards are all there, and j from the recap's
  // controls goes to the list's first card, as from any part of the list that isn't a card.
  await expect(cards(page)).toHaveCount(7);
  await lens.focus();
  await page.keyboard.press("j");
  await expect(card(page, CARDS.dana)).toBeFocused();
});
