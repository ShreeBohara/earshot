// Keeping this device's keys (Phase 5 spec WP3b). Keys kept on this device live in IndexedDB, which
// a browser may clear: when the disk runs low (best-effort sites first), and in Safari after seven
// days of use without a visit (its 7-day rule; docs/threat-model.md, "Known gaps"). Two answers:
// ask the browser once to keep the site's storage, and, on iOS Safari, suggest the Home Screen.

/** Where the request is remembered, so each browser is asked once (spec WP3b). */
export const PERSIST_KEY = "earshot.persist.v1";

/** The part of `navigator.storage` the request uses. */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
}

/** The part of `localStorage` that remembers the request. */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage`, or undefined where reading it throws (storage blocked) or it doesn't exist. */
function browserFlags(): FlagStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the browser, once and without a prompt of Earshot's own, to keep this site's storage
 * (`navigator.storage.persist()`). Call it after a key is stored on this device; WP9 adds turning
 * evidence clips on as the other trigger.
 *
 * - **How browsers answer:** Chrome grants or refuses silently, from engagement. Firefox asks the
 *   user. Safari decides by its own heuristics, and the one WebKit names is opening the site as a
 *   Home Screen app.
 * - **Once:** the request is remembered in `localStorage` before it's made, so two saves can't ask
 *   twice. With nowhere to remember it, it isn't made at all, since Firefox would ask on every save.
 *
 * Resolves to the browser's answer, or null when it didn't ask: already asked, no Storage API, or
 * nowhere to remember. Never throws.
 */
export async function requestPersistenceOnce(
  storage: StorageManagerLike | undefined = globalThis.navigator?.storage,
  flags: FlagStore | undefined = browserFlags(),
  now: () => Date = () => new Date(),
): Promise<boolean | null> {
  if (typeof storage?.persist !== "function" || !flags) return null;
  const at = now().toISOString();
  try {
    if (flags.getItem(PERSIST_KEY) !== null) return null;
    flags.setItem(PERSIST_KEY, JSON.stringify({ at, granted: null }));
  } catch {
    return null;
  }
  let granted = false;
  try {
    granted = (await storage.persist()) === true;
  } catch {
    // A refusal by exception counts as no.
  }
  try {
    flags.setItem(PERSIST_KEY, JSON.stringify({ at, granted }));
  } catch {
    // The request is remembered already; only its answer is lost.
  }
  return granted;
}

/** The parts of `navigator` the Home Screen hint reads. `standalone` exists only in iOS's WebKit. */
export interface NavigatorLike {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly standalone?: boolean;
}

/** iOS browsers other than Safari name themselves in the user agent. */
const OTHER_IOS_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\/|YaBrowser/;

/**
 * Whether Settings → Keys suggests the Home Screen: Safari on an iPhone or iPad, not opened as a
 * Home Screen app (`navigator.standalone !== true`).
 * - iPadOS's Safari asks for desktop sites, so it says "Macintosh"; touch tells it apart from a Mac.
 * - Other iOS browsers name themselves, and in-app browsers lack "Safari/". The hint is about
 *   Safari's Home Screen, so neither sees it.
 */
export function showsHomeScreenHint(nav: NavigatorLike): boolean {
  if (nav.standalone === true) return false;
  const ua = nav.userAgent;
  const iOS =
    /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && (nav.maxTouchPoints ?? 0) > 1);
  return iOS && ua.includes("Safari/") && !OTHER_IOS_BROWSERS.test(ua);
}
