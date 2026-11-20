import { readFileSync } from "node:fs";
import path from "node:path";
import { PilotManifest, type SeededError } from "@earshot/evals/pilot";
import { expect, type Page, type Request, test } from "@playwright/test";
import { settled } from "../inbox/support";
import { seriousViolations } from "../support/axe";

/** pilot.v1's manifest: the seeded errors' right answers, and each participant's order. */
export const MANIFEST = PilotManifest.parse(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "../../../../packages/evals/pilot/pilot.v1/manifest.json"),
      "utf8",
    ),
  ),
);

const SEEDED: ReadonlyMap<string, SeededError> = new Map(
  MANIFEST.seeded.map((error) => [error.proposalId, error]),
);

/** A request the page made, as the network check reads it. */
export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly type: string;
}

/** Every request and socket the page opens from now on. */
export function watchNetwork(page: Page): { requests: Seen[]; sockets: string[] } {
  const requests: Seen[] = [];
  const sockets: string[] = [];
  page.on("request", (request: Request) => {
    requests.push({ method: request.method(), url: request.url(), type: request.resourceType() });
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  return { requests, sockets };
}

const ORIGIN = new URL(process.env.BASE_URL ?? "http://localhost:3100").origin;

/**
 * The network check: every request a GET for the page itself or a static file of the build (its
 * scripts, styles, fonts, and icon), on the page's own origin. No fetch or XHR to anything, so no
 * API route, no server action (a POST), and nothing sent anywhere. Two things are `next dev`'s
 * own and absent from the built page: its hot-reload socket, the only socket allowed, and the
 * font files it serves from `/__nextjs_font/` until they're in `/_next/static/media/`.
 */
export function expectOnlyStaticFiles(requests: readonly Seen[], sockets: readonly string[]): void {
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

/** axe in both themes, once the page has stopped moving, leaving it in the light one. */
export async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);
    expect(await seriousViolations(page), `${state} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens /pilot for participant `p` on a cold dev server, and waits for its first screen. */
export async function openPilot(page: Page, p: string): Promise<void> {
  test.skip(Boolean(process.env.BASE_URL), "Runs against the local dev server.");
  await page.goto(`/pilot?p=${p}`);
  await expect(page.getByRole("button", { name: "I agree" })).toBeEnabled({ timeout: 60_000 });
}

/** The proposal id of the card holding focus, or null. */
export async function focusedCard(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.activeElement?.closest("[data-inbox-card]")?.getAttribute("data-proposal-id") ??
      null,
  );
}

/**
 * Decides the focused card by keyboard, with the manifest's right answer for a seeded error: "New"
 * for a flagged one (its number in the chooser), c then 2 for a silent one (the right record is
 * second in the correction panel); otherwise 1 for a card that asks for a choice, r for one with
 * no record, and a for the rest. Returns the keys it pressed.
 */
export async function decideFocused(page: Page): Promise<string[]> {
  const id = await focusedCard(page);
  expect(id, "a card holds focus").not.toBeNull();
  const card = page.locator(`[data-inbox-card][data-proposal-id="${id}"]`);
  const error = SEEDED.get(id as string);
  let keys: string[];
  if (error?.kind === "flagged") {
    // Each radio is named by the label around it: the record's name and its probability.
    const names = await card.getByRole("radiogroup").locator("label").allTextContents();
    const index = names.findIndex((name) => name.includes("A new record"));
    expect(index, "the question offers New").toBeGreaterThanOrEqual(0);
    keys = [String(index + 1)];
  } else if (error?.kind === "silent") {
    keys = ["c", "2"];
  } else if ((await card.getByRole("radiogroup").count()) > 0) {
    keys = ["1"];
  } else if ((await card.getByRole("heading").first().textContent())?.includes("No record")) {
    keys = ["r"];
  } else {
    keys = ["a"];
  }
  for (const key of keys) await page.keyboard.press(key);
  await expect(card).toHaveCount(0);
  return keys;
}
