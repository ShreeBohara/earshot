// What the capture screen says about each code. Codes come from the voice engine, the session
// socket, and the client; none of them ever carries a provider's own message or a key.
import type {
  Evidence,
  FieldValue,
  ProposalFieldV2,
  ProposalTypeV2,
  RiskFlagV2,
  RiskKindV2,
  SessionErrorCode,
  TargetCandidate,
  TargetV2,
  TurnOutcome,
} from "@earshot/core";
import type { NameNote, QuietReason, QuietReasonKind } from "@earshot/understanding/tiers";
import type { VoiceErrorCode } from "@earshot/voice";
import type { ClientIssueCode } from "@earshot/voice/session";

export interface Notice {
  readonly title: string;
  readonly body: string;
}

/** Copy for each voice engine error: the ones that stop capture, and the passing notices. */
export const VOICE_ERROR_COPY: Readonly<Record<VoiceErrorCode, Notice>> = {
  permission_denied: {
    title: "The microphone is blocked",
    body: "Earshot needs the microphone to hear your debrief. Allow it in your browser’s site settings (next to the address bar), then try again.",
  },
  permission_stuck: {
    title: "Safari lost the microphone",
    body: "The microphone failed even though Safari shows it as allowed. That’s a Safari bug (WebKit 319706): quit Safari completely, reopen it, and try again.",
  },
  device_unavailable: {
    title: "No microphone is available",
    body: "Check that a microphone is connected and that no other app is using it. Earshot can only use the microphone over HTTPS or on localhost.",
  },
  audio_unavailable: {
    title: "Audio couldn’t start",
    body: "The browser couldn’t start audio processing. Reload the page and try again.",
  },
  credential_failed: {
    title: "Couldn’t reach the speech provider",
    body: "Earshot couldn’t get a temporary credential for your speech-to-text provider. Your next press tries again.",
  },
  provider_rejected: {
    title: "The speech provider refused your key",
    body: "Check your speech-to-text key in Settings → Keys, then press again.",
  },
  provider_unavailable: {
    title: "The speech provider isn’t answering",
    body: "Your words are kept on this device for a minute. Press again to retry.",
  },
  provider_error: {
    title: "The speech provider reported an error",
    body: "Part of that turn may be missing from the transcript.",
  },
  rate_limited: {
    title: "The speech provider is limiting new connections",
    body: "AssemblyAI’s free tier allows 5 new streams a minute. Wait a moment, then press again.",
  },
  keyterms_rejected: {
    title: "CRM names weren’t accepted",
    body: "The speech provider refused the list of names to listen for. Transcription carries on without it.",
  },
  vad_unavailable: {
    title: "Hands-free’s speech detector didn’t load",
    body: "Hands-free still works, but turns end only when the provider hears a pause.",
  },
};

/** Copy for problems the session socket or client reported, as one sentence for the feed. */
export const SESSION_ISSUE_COPY: Readonly<Record<SessionErrorCode | ClientIssueCode, string>> = {
  bad_message: "A message was refused by the session, so it was dropped.",
  too_large: "A message was too large for the session, so it was dropped.",
  not_started: "The session wasn’t ready for that yet.",
  already_ended: "The session has ended, so it can’t take more.",
  sealed: "This session is closed to changes. Review the rest of its proposals in the inbox.",
  rate_limited: "Too many messages at once: Earshot slowed down and kept your words.",
  turn_limit: "This session reached its limit on turns. End it and start another.",
  duration_limit: "This session reached its time limit. End it and start another.",
  llm_key_rejected: "The model provider refused your key. Check it in Settings → Keys.",
  llm_rate_limited: "The model provider is limiting requests, so that turn got no proposals.",
  llm_unavailable: "The model provider couldn’t be reached, so that turn got no proposals.",
  internal: "Something went wrong on Earshot’s side with that turn.",
  missing_key: "No model key on this device, so that turn wasn’t sent. Add one in Settings → Keys.",
  bad_server_message:
    "The live view got a message it couldn’t read. Reload to catch up; nothing is lost.",
  bad_event: "The live view stopped updating. Reload to catch up; nothing is lost.",
  unknown_event: "This page is out of date. Reload to see the rest of the session.",
  foreign_event: "The live view ignored an update from another session.",
  desynced: "The live view stopped updating. Reload to catch up; nothing is lost.",
};

export const PROPOSAL_TYPE_LABELS: Readonly<Record<ProposalTypeV2, string>> = {
  note: "Note",
  task: "Task",
  contact: "Contact",
  deal_update: "Deal update",
  commitment: "Commitment",
  meeting: "Meeting",
};

const PROPOSAL_TYPE_PHRASES: Readonly<Record<ProposalTypeV2, string>> = {
  note: "a note",
  task: "a task",
  contact: "a contact",
  deal_update: "a deal update",
  commitment: "a commitment",
  meeting: "a meeting",
};

/** "a contact", "a contact and a task", "a contact, a task, and a note". */
export function listProposals(types: readonly ProposalTypeV2[]): string {
  const phrases = types.map((type) => PROPOSAL_TYPE_PHRASES[type]);
  if (phrases.length <= 2) return phrases.join(" and ");
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
}

/** What a finished turn did, for the activity feed and spoken confirmations. */
export function turnOutcomeText(outcome: TurnOutcome, types: readonly ProposalTypeV2[]): string {
  switch (outcome) {
    case "proposals":
      return types.length > 0 ? `Proposed ${listProposals(types)}.` : "Proposed changes.";
    case "nothing_to_propose":
      return "Nothing to propose from that turn.";
    case "invalid_output":
      return "The model’s answer didn’t hold up against the transcript, so nothing was proposed.";
    case "rate_limited":
      return "The model provider was limiting requests, so that turn got no proposals.";
    case "provider_error":
      return "The model provider failed, so that turn got no proposals.";
    case "cancelled":
      return "That turn was cancelled.";
  }
}

/**
 * What each risk badge says. `unsupported` means one thing wherever it appears (ADR-0027): the
 * words the model cited don't back what it wrote. A field whose quote isn't in the transcript is
 * dropped with it; a date, time, or amount whose quote says no such value keeps its value with
 * it; a target whose name isn't in the transcript links nothing. `date` and `number` come only
 * from Phase 3's sessions: Phase 4 checks those values against their words instead (ADR-0030).
 */
export const RISK_LABELS: Readonly<Record<RiskKindV2, string>> = {
  date: "Check the date",
  number: "Check the number",
  negation: "Check the negation",
  low_confidence: "Low confidence",
  unsupported: "Not backed by what was said",
  new_entity: "Creates a record",
  witness_conflict: "Transcripts disagree",
  link_uncertain: "Linked by sound",
  ambiguous_target: "Pick the record",
  implied_target: "Open account assumed",
  value_mismatch: "Differs from what was said",
  ambiguous_value: "Two readings",
  self_correction: "Corrected while speaking",
  weak_support: "Loosely backed by what was said",
};

/**
 * The quiet tier's notes (Phase 5 spec §4.4): a short line on the field or the card, no color, and
 * never a first-person line, which is for loud cards alone (lib/inbox/voice.ts). `quietNote` adds
 * what the note can show: the value a reading replaced, or the words in a negation.
 */
export const QUIET_NOTES: Readonly<Record<QuietReasonKind, string>> = {
  implied_target: "Open account assumed",
  new_entity: "Creates a record",
  value_corrected: "Corrected from what was written",
  negation: "Said in a negation",
  low_confidence: "Low confidence",
  weak_support: "Loosely backed by what was said",
  date: "Check the date",
  number: "Check the number",
};

/**
 * The note beside a record's name for a link that wasn't by its exact name or an alias, below
 * p 0.97 (`link_uncertain`; ADR-0031's option 2). It replaces the tray's "Linked by sound" badge.
 */
export const NAME_NOTES: Readonly<Record<NameNote, string>> = {
  sound: "matched by sound",
  context: "matched in context",
};

/** What a quiet note says: the value a reading replaced, or the negated words, when known. */
export function quietNote(
  reason: QuietReason,
  fields: Readonly<Record<string, Pick<ProposalFieldV2, "evidence" | "norm">>>,
  heard?: (evidence: Evidence) => string | undefined,
): string {
  const field = reason.field === null ? undefined : fields[reason.field];
  if (reason.kind === "value_corrected" && field?.norm?.llmValue !== undefined) {
    const was = spokenValue(reason.field ?? "", field.norm.llmValue, field.norm.currency);
    return `Corrected from ${was}`;
  }
  if (reason.kind === "negation" && field) {
    const words = heard?.(field.evidence);
    if (words) return `Said in a negation: “${words}”`;
  }
  return QUIET_NOTES[reason.kind];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * A value as a card says it in a sentence: "March 6" for a date, "2 pm" or "2:30 pm" for a time,
 * "$40,000" for an amount (in its words' currency, when they named one), "yes" or "no", "none".
 */
export function spokenValue(field: string, value: FieldValue, currency?: string): string {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (field !== "amount") return String(value);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  }
  if (DAY.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? value : monthDay.format(date);
  }
  const clock = CLOCK.exec(value);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = clock[2] ?? "00";
    if (hours <= 23) {
      const half = hours < 12 ? "am" : "pm";
      const hour = hours % 12 === 0 ? 12 : hours % 12;
      return minutes === "00" ? `${hour} ${half}` : `${hour}:${minutes} ${half}`;
    }
  }
  return value;
}

/** Badges on the target (`field: "target"`) that read better said of the record. */
const TARGET_RISK_LABELS: Partial<Readonly<Record<RiskKindV2, string>>> = {
  unsupported: "Record's name not in the transcript",
  witness_conflict: "Transcripts disagree on the name",
};

/** A risk badge's text: its kind, and the field it's on (the target needs no field name). */
export function riskLabel(flag: RiskFlagV2): string {
  const label = RISK_LABELS[flag.kind] ?? flag.kind;
  if (flag.field === undefined) return label;
  if (flag.field === "target") return TARGET_RISK_LABELS[flag.kind] ?? label;
  return `${label}: ${fieldLabel(flag.field).toLowerCase()}`;
}

/**
 * A conflict between the two witnesses (Phase 4 WP9): the live transcript's words, and what the
 * second witness heard over the same audio. Phase 4's tray only shows it; Phase 5 resolves it.
 */
export const CONFLICT_COPY = {
  pill: "Heard two ways",
  list: "Where the transcripts disagree",
  biased: "Live transcript",
  unbiased: "Second witness",
  /** The second witness had no words there. */
  unheard: "nothing",
} as const;

/** A question names candidates at least this likely, or the most likely one alone. */
export const ASK_MIN_P = 0.05;

/** The candidates a question names: at most three records and "new", most likely first. */
export function askCandidates(target: Pick<TargetV2, "candidates">): TargetCandidate[] {
  const likely = target.candidates.filter((candidate) => candidate.p >= ASK_MIN_P);
  return likely.length > 0 ? likely : target.candidates.slice(0, 1);
}

/** "A", "A or B", "A, B, or C". */
function either(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

/**
 * What a card says about its record, after any downgrade: the linked record's name; "Ask: Acme
 * Dynamics or Akme Dynamics?" when the linker asks; "New" for a record to create; "No record"
 * when none was named or the name wasn't found. Phase 4's tray is read-only; Phase 5 answers.
 */
export function targetHeading(target: TargetV2, nameOf: (entityId: string) => string): string {
  switch (target.decision) {
    case "linked":
      return target.entityId === null ? "No record" : nameOf(target.entityId);
    case "ask": {
      const names = askCandidates(target).map((candidate) =>
        candidate.entityId === null ? "a new record" : nameOf(candidate.entityId),
      );
      return names.length > 0 ? `Ask: ${either(names)}?` : "Ask";
    }
    case "new":
      return "New";
    case "none":
      return "No record";
  }
}

/** `nextStep` as "Next step". */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
