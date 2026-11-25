// What the inbox says (Phase 5 spec WP5 steps 2, 7, and 10): its sections, its group headings,
// each card's name in a sentence, and the one message each action gets ("Accepted: task for Acme
// Corp. 4 left. Press U to undo."). The first-person lines live in ./voice.ts; the quiet notes and
// the name note in lib/capture/copy.ts, beside the tray's labels.
import type { FieldValue, ProposalTypeV2 } from "@earshot/core";
import { spokenValue } from "@/lib/capture/copy";
import { ruleWords } from "@/lib/policies/copy";
import type { StayReason } from "./batch";
import type { SinkRefusal } from "./sinks";
import type { InboxEntity, InboxProposal } from "./types";

export const SECTION_TITLES = {
  review: "Needs review",
  finishing: "Finishing",
  reviewed: "Reviewed",
  snoozed: "Snoozed",
} as const;

export const FINISHING_COPY = {
  ended: "Finishing, usually under a minute",
  live: "Still being recorded",
  detail:
    "Earshot is saving the rest of this debrief. Its proposals appear here to review once it's done.",
} as const;

/** The "All caught up" heading, and what it says under it. */
export const CAUGHT_UP_COPY = {
  done: "All caught up",
  doneDetail: "Nothing needs your review. New debriefs appear here once they finish.",
  empty: "Nothing to review yet",
  emptyDetail:
    "Debrief a call, or load the sample debriefs in Settings → Data, and its proposals appear here.",
} as const;

const TYPE_WORDS: Readonly<Record<ProposalTypeV2, string>> = {
  note: "note",
  task: "task",
  contact: "contact",
  deal_update: "deal update",
  commitment: "commitment",
  meeting: "meeting",
};

/** HubSpot's default deal stages, as the demo CRM stores them, in words. */
export const DEAL_STAGE_LABELS: Readonly<Record<string, string>> = {
  appointmentscheduled: "Appointment scheduled",
  qualifiedtobuy: "Qualified to buy",
  presentationscheduled: "Presentation scheduled",
  decisionmakerboughtin: "Decision maker bought in",
  contractsent: "Contract sent",
  closedwon: "Closed won",
  closedlost: "Closed lost",
};

/** A field's value as a card shows it: amounts as money, dates as days, stages in words. */
export function shownValue(field: string, value: FieldValue, currency?: string): string {
  if (value === null) return "None";
  if (field === "stage" && typeof value === "string" && DEAL_STAGE_LABELS[value]) {
    return DEAL_STAGE_LABELS[value];
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "amount" || field === "closeDate" || field === "dueDate" || field === "date") {
    const spoken = spokenValue(field, value, currency);
    return spoken.charAt(0).toUpperCase() + spoken.slice(1);
  }
  if (field === "time") return spokenValue(field, value);
  return String(value);
}

type NameOf = (entityId: string) => string;

/** A name finder over the inbox's records, with a fallback for one the mirror lost. */
export function nameFinder(entities: Readonly<Record<string, InboxEntity>>): NameOf {
  return (entityId) => entities[entityId]?.name ?? "a CRM record";
}

/** The record a card is about, in a sentence: its name, "a new record", or "no record". */
export function recordWords(proposal: InboxProposal, nameOf: NameOf): string {
  const { target } = proposal;
  switch (target.decision) {
    case "linked":
      return target.entityId === null ? "no record" : nameOf(target.entityId);
    case "ask":
      return "a record to choose";
    case "new":
      return "a new record";
    case "none":
      return "no record";
  }
}

/** "task for Acme Corp": a card in a sentence, by the record it chose, if any. */
export function cardWords(
  proposal: InboxProposal,
  nameOf: NameOf,
  chosen?: { readonly entityId: string | null } | null,
): string {
  const type = TYPE_WORDS[proposal.type];
  if (chosen)
    return `${type} for ${chosen.entityId === null ? "a new record" : nameOf(chosen.entityId)}`;
  const record = recordWords(proposal, nameOf);
  return record === "no record" || record === "a record to choose" ? type : `${type} for ${record}`;
}

/** "4 left.", "1 left.", or "All caught up." */
export function leftWords(left: number): string {
  return left === 0 ? "All caught up." : `${left} left.`;
}

/** The one polite message each action gets. */
export type ActionMessage =
  | { readonly kind: "accepted"; readonly what: string }
  | { readonly kind: "edited"; readonly what: string }
  | { readonly kind: "chose"; readonly what: string; readonly choice: string }
  | { readonly kind: "rejected"; readonly what: string }
  | { readonly kind: "snoozed"; readonly what: string; readonly until: string }
  | { readonly kind: "restored"; readonly what: string };

/**
 * "Accepted: task for Acme Corp. 4 left. Press U to undo." The key hint only while the shortcuts
 * are on; a restored card needs none.
 */
export function actionMessage(message: ActionMessage, left: number, shortcuts: boolean): string {
  const undo = shortcuts ? " Press U to undo." : "";
  const tail = `${leftWords(left)}${undo}`;
  switch (message.kind) {
    case "accepted":
      return `Accepted: ${message.what}. ${tail}`;
    case "edited":
      return `Edited and accepted: ${message.what}. ${tail}`;
    case "chose":
      return `Chose ${message.choice} and accepted: ${message.what}. ${tail}`;
    case "rejected":
      return `Rejected: ${message.what}. ${tail}`;
    case "snoozed":
      return `Snoozed until ${message.until}: ${message.what}. ${tail}`;
    case "restored":
      return `Back for review: ${message.what}. ${leftWords(left)}`;
  }
}

const FAILURE_REASONS: Readonly<Record<SinkRefusal, string>> = {
  stale: "it changed since the page loaded. Reload to see it as it is now",
  not_sealed: "its debrief is still finishing. Try again in a minute",
  sealed: "its debrief is done. Review it in the inbox",
  unavailable: "reviews can't be recorded right now. Try again later",
  invalid: "Earshot couldn't record that review. Reload and try again",
  gone: "its debrief isn't there any more",
  signed_out: "you're signed out. Sign in again and try once more",
  failed: "Earshot couldn't reach the server. Try again",
};

const FAILURE_VERBS = {
  review: "record your review of",
  snooze: "snooze",
  undo: "undo your review of",
  wake: "bring back",
} as const;

/** The urgent message for a change that didn't land. */
export function failureMessage(
  verb: keyof typeof FAILURE_VERBS,
  what: string,
  reason: SinkRefusal,
): string {
  return `Couldn't ${FAILURE_VERBS[verb]} the ${what}: ${FAILURE_REASONS[reason]}.`;
}

// ─── "Accept all from this call" (spec WP6 step 1) ──────────────────────────────────────────────

/** The checkpoint's fixed words. */
export const BATCH_COPY = {
  title: "Accept all from this call",
  accepts: "Will be accepted",
  stays: "Stays for review",
  cancel: "Cancel",
  /** The button's label when nothing is unmarked. */
  none: "Accept all unmarked",
  /** "Reviewed"'s word for a batch. */
  decided: "Accepted together",
} as const;

function proposalsWord(count: number): string {
  return count === 1 ? "proposal" : "proposals";
}

function staysWords(count: number): string {
  return `${count} ${count === 1 ? "stays" : "stay"} for review.`;
}

/** The session header's button: "Accept 3 unmarked". */
export function batchButtonLabel(count: number): string {
  return count > 0 ? `Accept ${count} unmarked` : BATCH_COPY.none;
}

/** Why the button is disabled: nothing in the debrief can join a batch. */
export function batchNoneReason(reasons: readonly StayReason[]): string {
  const marked = reasons.every(
    (reason) => reason === "loud" || reason === "quiet" || reason === "name_note",
  );
  if (marked) return "Every card here is marked, so each needs a look.";
  if (reasons.includes("saving")) return "Your last review here is still saving.";
  return "Nothing here can be accepted as it stands.";
}

/** The checkpoint's summary, which the confirm button is described by. */
export function batchSummary(accepts: number, stays: number): string {
  return `${accepts} will be accepted. ${stays > 0 ? staysWords(stays) : "Nothing stays for review."}`;
}

/** Why a card stays out of the batch, in a few words, from what the card shows. */
export function stayWords(
  reason: StayReason,
  card: {
    readonly firstPerson: { readonly lead: string } | null;
    readonly notes: readonly string[];
    readonly fields: readonly { readonly notes: readonly string[] }[];
    readonly nameNote: string | null;
  },
): string {
  switch (reason) {
    case "loud":
      return card.firstPerson ? `Needs a check: ${card.firstPerson.lead}` : "Needs a check";
    case "quiet": {
      const note = card.notes[0] ?? card.fields.find((field) => field.notes.length > 0)?.notes[0];
      return note ? `Has a note: ${note}` : "Has a note";
    }
    case "name_note":
      return card.nameNote ? `Record ${card.nameNote}` : "Record matched loosely";
    case "no_record":
      return "No record to add it to";
    case "saving":
      return "Your last review of it is still saving";
  }
}

/** The one polite message for a batch: "Accepted 3. 2 stay for review. Press U to undo." */
export function batchMessage(
  accepted: number,
  stays: number,
  left: number,
  shortcuts: boolean,
): string {
  const undo = shortcuts ? " Press U to undo." : "";
  return `Accepted ${accepted}. ${stays > 0 ? staysWords(stays) : leftWords(left)}${undo}`;
}

/** A batch undone: its cards back for review. */
export function batchRestoredMessage(count: number, left: number): string {
  return `Back for review: ${count} ${proposalsWord(count)}. ${leftWords(left)}`;
}

const BATCH_FAILURE_REASONS: Readonly<Record<SinkRefusal, string>> = {
  stale: "one of them changed since the page loaded. Reload to see them as they are now",
  not_sealed: "their debrief is still finishing. Try again in a minute",
  sealed: "their debrief is done. Review them in the inbox",
  unavailable: "reviews can't be recorded right now. Try again later",
  invalid: "Earshot couldn't record those reviews. Reload and try again",
  gone: "their debrief isn't there any more",
  signed_out: "you're signed out. Sign in again and try once more",
  failed: "Earshot couldn't reach the server. Try again",
};

/**
 * The one urgent message for a batch, or its undo, that didn't all land. `landed` of `total` did:
 * a batch longer than one request goes in several, and a refusal stops the rest, so the earlier
 * parts stand and the message says so.
 */
export function batchFailureMessage(
  verb: "accept" | "undo",
  total: number,
  landed: number,
  reason: SinkRefusal,
): string {
  const why = BATCH_FAILURE_REASONS[reason];
  const doing = verb === "accept" ? "accept" : "bring back";
  if (landed === 0) {
    return total === 1
      ? `Couldn't ${doing} the proposal: ${FAILURE_REASONS[reason]}.`
      : `Couldn't ${doing} the ${total} proposals: ${why}.`;
  }
  const done = verb === "accept" ? "Accepted" : "Brought back";
  const rest = total - landed;
  return `${done} ${landed} of ${total}. Couldn't ${doing} the other ${rest}: ${rest === 1 ? FAILURE_REASONS[reason] : why}.`;
}

/** "Reviewed"'s row for a batch: "3 proposals: task for Sean Murphy, …". */
export function batchRowWords(cards: readonly string[]): string {
  const count = cards.length;
  return `${count} ${proposalsWord(count)}: ${cards.join(", ")}`;
}

/**
 * What a decided proposal's row in "Reviewed" says it was. An approval policy's names its rule
 * (Phase 5 WP11): "Approved by your policy: notes".
 */
export function decisionWords(proposal: InboxProposal): string {
  if (proposal.review?.mode === "policy") {
    const rule = proposal.review.policy?.rule;
    return rule ? `Approved by your policy: ${ruleWords(rule)}` : "Approved by your policy";
  }
  switch (proposal.status) {
    case "approved":
      return "Accepted";
    case "edited":
      return "Edited and accepted";
    case "rejected":
      return "Rejected";
    default:
      return "Reviewed";
  }
}

/** What a card says when an action can't go ahead as it stands, with or without the keys on. */
export const KEY_HINTS = {
  choose: "Choose a record first: press 1, 2, or 3, or pick one and accept.",
  chooseWithoutKeys: "Choose a record first, then accept.",
  noRecord: "There's no record to add this to. Reject it, or correct it with C.",
  noRecordWithoutKeys: "There's no record to add this to. Reject it, or correct it from More.",
  nothingToUndo: "Nothing to undo yet.",
} as const;

/** The hint for a card that needs a record chosen first. */
export function chooseHint(shortcuts: boolean): string {
  return shortcuts ? KEY_HINTS.choose : KEY_HINTS.chooseWithoutKeys;
}

/** The hint for a card with no record to accept. */
export function noRecordHint(shortcuts: boolean): string {
  return shortcuts ? KEY_HINTS.noRecord : KEY_HINTS.noRecordWithoutKeys;
}
