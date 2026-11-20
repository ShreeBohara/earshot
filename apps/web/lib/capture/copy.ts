// What the capture screen says about each code. Codes come from the voice engine, the session
// socket, and the client; none of them ever carries a provider's own message or a key.
import type { ProposalTypeV2, SessionErrorCode, TurnOutcome } from "@earshot/core";
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

export const RISK_LABELS: Readonly<Record<string, string>> = {
  date: "Check the date",
  number: "Check the number",
  negation: "Check the negation",
  low_confidence: "Low confidence",
  unsupported: "No supporting words",
  new_entity: "Creates a record",
  witness_conflict: "Transcripts disagree",
};

/** `nextStep` as "Next step". */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
