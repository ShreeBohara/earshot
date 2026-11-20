// The inline editor's rules (Phase 5 spec WP5 step 5): what each field accepts, the errors tied to
// it, and the edit as `editDiff`. Pure, so the tests read it without a page.
import type { FieldEdit, FieldValue } from "@earshot/core";
import type { InboxProposal } from "./types";

/** Fields whose value is a calendar date, `YYYY-MM-DD` (as the extractor's schema says). */
export const DATE_FIELDS: ReadonlySet<string> = new Set(["dueDate", "closeDate", "date"]);
/** Fields whose value is a time of day, `HH:MM` on a 24-hour clock. */
export const TIME_FIELDS: ReadonlySet<string> = new Set(["time"]);

/** The editor's text for each field. */
export type EditDraft = Readonly<Record<string, string>>;

export type EditResult =
  | { readonly ok: true; readonly values: Readonly<Record<string, FieldValue>> }
  | {
      readonly ok: false;
      /** By field: what's wrong with it, in a sentence. */
      readonly errors: Readonly<Record<string, string>>;
      /** About the edit as a whole. */
      readonly formError: string | null;
    };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Strips what people type around a number: currency signs, thousands commas, spaces. */
function numberText(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char !== "," && char !== "$" && char !== " " && char !== " ") out += char;
  }
  return out;
}

function isRealDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Reads the editor's text as values, by each field's kind: a number where the proposal had one, a
 * real day for a date, `HH:MM` for a time, the words otherwise. An emptied field is no value. An
 * edit has to change something.
 */
export function readEdit(proposal: InboxProposal, draft: EditDraft): EditResult {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};
  for (const [name, field] of Object.entries(proposal.fields)) {
    const text = (draft[name] ?? "").trim();
    if (text === "") {
      values[name] = null;
      continue;
    }
    if (typeof field.value === "number") {
      const parsed = Number(numberText(text));
      if (!Number.isFinite(parsed)) errors[name] = "Enter a number, like 40000.";
      else values[name] = parsed;
    } else if (DATE_FIELDS.has(name)) {
      if (!isRealDay(text)) errors[name] = "Enter a date, like 2026-11-27.";
      else values[name] = text;
    } else if (TIME_FIELDS.has(name)) {
      if (!CLOCK.test(text)) errors[name] = "Enter a time, like 14:30.";
      else values[name] = text;
    } else if (typeof field.value === "boolean") {
      values[name] = /^(yes|true)$/i.test(text);
    } else {
      values[name] = text;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, formError: null };
  if (Object.keys(editDiff(proposal, values)).length === 0) {
    return {
      ok: false,
      errors: {},
      formError: "Nothing changed. Change a value to save it, or press Esc to cancel.",
    };
  }
  return { ok: true, values };
}

/** The fields an edit changed, each with its value before and after. */
export function editDiff(
  proposal: InboxProposal,
  values: Readonly<Record<string, FieldValue>>,
): Record<string, FieldEdit> {
  const diff: Record<string, FieldEdit> = {};
  for (const [name, field] of Object.entries(proposal.fields)) {
    if (!(name in values)) continue;
    const after = values[name] ?? null;
    if (after !== field.value) diff[name] = { before: field.value, after };
  }
  return diff;
}
