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

/** Whether this device keeps clips: on unless it turned them off, and on where storage won't say. */
export function readClipsSetting(storage?: Pick<Storage, "getItem"> | null): ClipsSetting {
  try {
    return storage?.getItem(CLIPS_SETTING_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

/** Records the device's choice, and tells this tab's listeners. */
export function writeClipsSetting(
  setting: ClipsSetting,
  target: { storage?: Pick<Storage, "setItem"> | null; events?: EventTarget | null } = {},
): void {
  try {
    target.storage?.setItem(CLIPS_SETTING_KEY, setting);
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
  target.events?.dispatchEvent(new Event(CLIPS_SETTING_EVENT));
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
