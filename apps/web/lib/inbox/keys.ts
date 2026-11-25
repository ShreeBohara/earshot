// The inbox's single-key shortcuts (Phase 5 spec decision 7, WP5 step 6; WCAG 2.2 SC 2.1.4).
//
// - j and k move; a accepts; e edits; r rejects; s snoozes until tomorrow at 9:00; c opens the
//   correction panel; u undoes; 1 to 4 choose and accept (on a 3-way card with no choices of its
//   own, Phase 5 WP12, 1 keeps the rep's value and 2 the CRM's); ? lists the keys.
// - They act only while focus is in the inbox's list, and never from a text field. The page wires
//   that scope (use-inbox-keys.ts); this module only reads a key.
// - Settings → Review turns them off, per device (`earshot.inbox.shortcuts`, in localStorage, like
//   the second witness's answer). They're on by default, unlike Gmail's, which hide the fastest
//   path from everyone.
// - No Space (push-to-talk while a debrief is docked), no ⌘↵ (the APG avoids modifiers with
//   Enter), and every key is its action's first letter, so undo is u, not Gmail's z.

/** What a key asks of the inbox. */
export type InboxKeyAction =
  | { readonly kind: "move"; readonly step: 1 | -1 }
  | { readonly kind: "accept" }
  | { readonly kind: "edit" }
  | { readonly kind: "reject" }
  | { readonly kind: "snooze" }
  | { readonly kind: "correct" }
  | { readonly kind: "undo" }
  /** 1 to 4: the option at `index` (0-based) in the card's chooser or correction panel. */
  | { readonly kind: "choose"; readonly index: number }
  | { readonly kind: "help" };

/** The most choices a card numbers: three records and "New" (the linker's limit). */
export const MAX_CHOICES = 4;

/** What a key event carries that the shortcuts read. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly target: unknown;
}

/** Input types where a letter is a letter, not a shortcut. */
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/**
 * Whether a key from `target` belongs to a text field: an input that takes text, a textarea, a
 * select, or anything editable. Read by shape, not `instanceof`, so it works on any element.
 */
export function isTextEntry(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as {
    readonly tagName?: unknown;
    readonly type?: unknown;
    readonly isContentEditable?: unknown;
  };
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * The action a key asks for, or null when it isn't a shortcut here: a modifier is held (Shift
 * only types `?`), it comes from a text field, an input method is composing, or it's held down
 * (only j and k repeat).
 */
export function inboxKeyAction(event: KeyLike): InboxKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  if (isTextEntry(event.target)) return null;
  const { key } = event;
  if (key === "j" || key === "J") return { kind: "move", step: 1 };
  if (key === "k" || key === "K") return { kind: "move", step: -1 };
  if (event.repeat) return null;
  switch (key.toLowerCase()) {
    case "a":
      return { kind: "accept" };
    case "e":
      return { kind: "edit" };
    case "r":
      return { kind: "reject" };
    case "s":
      return { kind: "snooze" };
    case "c":
      return { kind: "correct" };
    case "u":
      return { kind: "undo" };
    case "?":
      return { kind: "help" };
    default:
      break;
  }
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < MAX_CHOICES ? { kind: "choose", index } : null;
  }
  return null;
}

/** The keys, as the help dialog and Settings → Review list them. */
export const INBOX_SHORTCUTS: readonly {
  readonly keys: readonly string[];
  readonly action: string;
}[] = [
  { keys: ["J", "K"], action: "Next card, previous card" },
  { keys: ["A"], action: "Accept" },
  { keys: ["E"], action: "Edit, then Enter to save or Esc to cancel" },
  { keys: ["R"], action: "Reject" },
  { keys: ["S"], action: "Snooze until tomorrow at 9:00 am" },
  { keys: ["C"], action: "Correct: choose another record" },
  {
    keys: ["1", "2", "3"],
    action:
      "Choose that option and accept. Where the CRM changed since you spoke, 1 keeps yours and 2 the CRM's",
  },
  { keys: ["U"], action: "Undo your last review" },
  { keys: ["?"], action: "Show these shortcuts" },
];

/** Where the device keeps its choice. */
export const SHORTCUTS_SETTING_KEY = "earshot.inbox.shortcuts";

/** Dispatched on `window` when this tab changes it (`storage` covers other tabs). */
export const SHORTCUTS_SETTING_EVENT = "earshot:inbox-shortcuts";

/** Whether this device has the shortcuts on: on unless it turned them off. */
export function readShortcutsSetting(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(SHORTCUTS_SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Records the device's choice, and tells this tab's listeners. */
export function writeShortcutsSetting(
  on: boolean,
  target: { storage?: Pick<Storage, "setItem"> | null; events?: EventTarget | null } = {},
): void {
  try {
    target.storage?.setItem(SHORTCUTS_SETTING_KEY, on ? "on" : "off");
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
  target.events?.dispatchEvent(new Event(SHORTCUTS_SETTING_EVENT));
}
