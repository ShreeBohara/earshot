// The second witness on this device (Phase 4 spec WP9 step 4, decision 8; ADR-0029). After each
// turn the browser sends that turn's audio, with no keyterms, to Groq Whisper on the rep's own
// Groq key, and SessionDO compares the two transcripts at every name. It sends the rep's audio to
// a second processor, so it runs only with consent: asked once per device, with "yes"
// preselected, and only when a Groq key is on the device. Without one it's off.
//
// The answer lives in this browser's localStorage, like the device's keys live in its IndexedDB:
// another device asks again. It's a preference, not a secret.
import type { StoredKeyMeta } from "@earshot/keys";

/** Where the device keeps its answer. */
export const WITNESS_SETTING_KEY = "earshot.capture.witness";

/** Dispatched on `window` when this tab changes the setting (`storage` covers other tabs). */
export const WITNESS_SETTING_EVENT = "earshot:witness-setting";

/** Groq Whisper, or off. No value at all means the device hasn't been asked yet. */
export type WitnessSetting = "groq" | "off";

/** What a debrief on this device runs: the witness, nothing (`off`), or nothing for want of a key. */
export type WitnessStatus = "on" | "off" | "no_key";

export const WITNESS_COPY = {
  name: "Second witness",
  /** The spec's line, wherever the setting is offered. */
  line: "Sends each turn’s audio to Groq too, about $0.001 per debrief.",
  how: "Earshot compares the two transcripts at every name and flags a card when they disagree. Your Groq key and the audio go from this browser to Groq, never through Earshot.",
  privacy: "Turn on Zero Data Retention under Data Controls in Groq’s console first.",
  options: { groq: "Groq Whisper", off: "Off" } satisfies Record<WitnessSetting, string>,
  status: {
    on: "Second witness: Groq Whisper",
    fake: "Second witness: fake (development)",
    off: "Second witness: off",
    no_key: "Second witness: on, but no Groq key on this device",
  },
} as const;

export function parseWitnessSetting(value: string | null | undefined): WitnessSetting | null {
  return value === "groq" || value === "off" ? value : null;
}

/** The device's answer, or null before it's been asked (or where storage is unavailable). */
export function readWitnessSetting(
  storage?: Pick<Storage, "getItem"> | null,
): WitnessSetting | null {
  try {
    return parseWitnessSetting(storage?.getItem(WITNESS_SETTING_KEY));
  } catch {
    return null;
  }
}

/** Records the device's answer, and tells this tab's listeners. */
export function writeWitnessSetting(
  setting: WitnessSetting,
  target: { storage?: Pick<Storage, "setItem"> | null; events?: EventTarget | null } = {},
): void {
  try {
    target.storage?.setItem(WITNESS_SETTING_KEY, setting);
  } catch {
    // Storage full or blocked: the answer lasts for this page only.
  }
  target.events?.dispatchEvent(new Event(WITNESS_SETTING_EVENT));
}

/** Whether this device holds a Groq key: the witness's only provider. */
export function hasGroqKey(keys: readonly Pick<StoredKeyMeta, "provider">[]): boolean {
  return keys.some((key) => key.provider === "groq");
}

/** Whether to ask now (decision 8): a Groq key is here, and the device hasn't answered. */
export function witnessPromptDue(
  setting: WitnessSetting | null,
  keys: readonly Pick<StoredKeyMeta, "provider">[],
): boolean {
  return setting === null && hasGroqKey(keys);
}

/** What a debrief runs with this answer and these keys. Unanswered is off. */
export function witnessStatus(
  setting: WitnessSetting | null,
  keys: readonly Pick<StoredKeyMeta, "provider">[],
): WitnessStatus {
  if (setting !== "groq") return "off";
  return hasGroqKey(keys) ? "on" : "no_key";
}
