import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Waits until no finite animation or transition is running, and no Base UI part is entering or
 * leaving, before axe reads the page. A dialog or toast caught mid-fade has text at partial
 * opacity, which axe reads as low contrast; endless animations (a spinner) don't count; and a part
 * keeps `data-starting-style` or `data-ending-style` until it has fully arrived or gone, past the
 * end of its transition.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector("[data-starting-style], [data-ending-style]") === null &&
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
        ),
  );
}

async function read(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

/**
 * Serious and critical WCAG 2.2 AA violations on the page, one line each. One counts only if axe
 * finds it again once the page has settled, because a part that leaves while axe reads can fail a
 * rule on its way out. A toast that times out mid-read slides off screen before it unmounts, so axe
 * stops counting it as an open dialog, and flags the close button that Base UI hides from
 * assistive tech while the stack is collapsed (aria-hidden-focus).
 */
export async function seriousViolations(page: Page): Promise<string[]> {
  const first = await read(page);
  if (first.length === 0) return first;
  await settled(page);
  return read(page);
}
