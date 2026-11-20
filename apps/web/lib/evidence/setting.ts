// Evidence clips on this device (Phase 5 spec decision 6, WP9; ADR-0036): on unless this device
// turned them off in Settings → Capture. A preference in this browser's localStorage, like the
// second witness's answer: another device has its own. The clips themselves live in IndexedDB
// (`@earshot/voice/evidence`).
//
// The capture screen says once that clips are on (the notice), remembered here too.

/** Where the device keeps its choice. Absent means on. */
export const CLIPS_SETTING_KEY = "earshot.capture.clips";

/** Dispatched on `window` when this tab changes the setting (`storage` covers other tabs). */
export const CLIPS_SETTING_EVENT = "earshot:clips-setting";

/** Where the device remembers that the capture screen's notice was shown and dismissed. */
export const CLIPS_NOTICE_KEY = "earshot.capture.clips-notice.v1";

export type ClipsSetting = "on" | "off";

/**
 * This browser's `localStorage`, or undefined while server rendering or where reading the property
 * itself throws, as it does when policy blocks site storage. Every read and write of the setting,
 * the notice, and the clips' owner goes through it, so blocked storage disables clips rather than
 * breaking the page that renders them (Codex's review of #62).
 */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * This page's own choice, kept when the browser wouldn't save it (storage full or blocked), so a
 * failed write can never turn clips back on after the rep turned them off. Shared by the settings
 * page and the capture controller, since both read through `readClipsSetting`.
 */
let unsaved: ClipsSetting | null = null;

/** Whether this device keeps clips: on unless it turned them off, and on where storage won't say. */
export function readClipsSetting(storage?: Pick<Storage, "getItem"> | null): ClipsSetting {
  if (unsaved !== null) return unsaved;
  try {
    return storage?.getItem(CLIPS_SETTING_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

/**
 * Records the device's choice, and tells this tab's listeners. Where the browser won't save it, the
 * choice still holds for the rest of this page (`unsaved`).
 */
export function writeClipsSetting(
  setting: ClipsSetting,
  target: { storage?: Pick<Storage, "setItem"> | null; events?: EventTarget | null } = {},
): void {
  if (!target.storage) {
    unsaved = setting;
  } else {
    try {
      target.storage.setItem(CLIPS_SETTING_KEY, setting);
      unsaved = null;
    } catch {
      unsaved = setting;
    }
  }
  target.events?.dispatchEvent(new Event(CLIPS_SETTING_EVENT));
}

/** For tests: forgets the page's unsaved choice. */
export function forgetUnsavedClipsSetting(): void {
  unsaved = null;
}

/**
 * Whether the capture screen still owes this device its one-time notice. Not where storage can't
 * remember it (it would show on every visit), nor anywhere storage can't be read at all.
 */
export function clipsNoticeDue(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(CLIPS_NOTICE_KEY) === null;
  } catch {
    return false;
  }
}

/** The notice was dismissed, or a debrief started with it on screen: it's shown once. */
export function markClipsNoticeSeen(
  storage: Pick<Storage, "setItem"> | null | undefined,
  now: Date = new Date(),
): void {
  try {
    storage?.setItem(CLIPS_NOTICE_KEY, now.toISOString());
  } catch {
    // Can't remember it: the notice may show again, which is harmless.
  }
}
