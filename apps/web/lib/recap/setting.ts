// The recap's methodology lens on this device (Phase 5 spec WP10 step 3): MEDDIC, SPICED, BANT, or
// none, chosen in Settings → Capture and sent with `end`. A preference in this browser's
// localStorage, like the evidence clips switch: another device has its own.
import type { RecapLensId } from "@earshot/core";

/** Where the device keeps its choice. Absent means none. */
export const RECAP_LENS_KEY = "earshot.capture.recap-lens";

/** Dispatched on `window` when this tab changes the setting (`storage` covers other tabs). */
export const RECAP_LENS_EVENT = "earshot:recap-lens";

const LENSES: ReadonlySet<string> = new Set(["meddic", "spiced", "bant"]);

/** The device's lens, or null for none, and where storage can't say. */
export function readRecapLens(storage?: Pick<Storage, "getItem"> | null): RecapLensId | null {
  try {
    const value = storage?.getItem(RECAP_LENS_KEY) ?? null;
    return value !== null && LENSES.has(value) ? (value as RecapLensId) : null;
  } catch {
    return null;
  }
}

/** Records the device's choice (null for none), and tells this tab's listeners. */
export function writeRecapLens(
  lens: RecapLensId | null,
  target: {
    storage?: Pick<Storage, "setItem" | "removeItem"> | null;
    events?: EventTarget | null;
  } = {},
): void {
  try {
    if (lens === null) target.storage?.removeItem(RECAP_LENS_KEY);
    else target.storage?.setItem(RECAP_LENS_KEY, lens);
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
  target.events?.dispatchEvent(new Event(RECAP_LENS_EVENT));
}
