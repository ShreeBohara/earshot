// First-person uncertainty (Phase 5 spec decision 9, §4.4; ADR-0035): one template per loud reason,
// in the UI's words, on loud cards only. Never on a quiet or unmarked card, and never written by a
// model. Kim et al. (FAccT 2024) cut agreement with a wrong AI by phrasing its doubt in the first
// person, but put the doubt on a random half of the answers; Earshot puts it only where `tierOf`
// says a reviewer has something to settle, since over-flagging buys underreliance.
//
// | Reason | Line |
// |---|---|
// | Witness conflict on the target | I'm not sure I caught the company. Acme or Akme? |
// | Witness conflict on a field | I'm not sure I caught the name. "Dana Lee" or "Dana Li"? |
// | The linker asked | I'm not sure which company you meant. Acme Dynamics or Akme Dynamics? |
// | Unsupported target | I couldn't find the company's name in what you said, so I haven't picked a record. |
// | Unsupported field | I couldn't find the words for the due date in what you said. |
// | Ambiguous value | I heard "next Friday". Did you mean the 27th or the 4th? |
// | Mismatch not fixed, after a correction | You corrected yourself here, and I may have kept the first date: March 6. |
// | Mismatch not fixed, otherwise | I may not have written the email the way you said it: dana@acme.io. |
// | New, with a sound-alike | I didn't find "Atmo Systems" in your CRM. Did you mean Atmos Industrial, or is it new? |
// | Re-link offer (WP12) | Acme Robotics was added to your CRM after you spoke. Is it this one? |
// | The CRM changed since (WP12, a 3-way card) | The stage changed in your CRM after you spoke. Keep yours or the CRM's? |
//
// The line's first sentence is also the card's accessible description: "Task, Acme Corp, needs a
// check: I'm not sure I caught the company."
import type { EntityKind, Evidence } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import {
  type LoudReason,
  type LoudReasonKind,
  SOUND_ALIKE_MIN_P,
  type Tier,
} from "@earshot/understanding/tiers";
import { askCandidates, fieldLabel, PROPOSAL_TYPE_LABELS, spokenValue } from "@/lib/capture/copy";

/** What a line reads of a proposal: `ProposalView`'s fields, conflicts included. */
export type VoiceProposal = Pick<
  ProposalView,
  "type" | "target" | "fields" | "riskFlags" | "conflicts"
>;

export interface VoiceContext {
  /** A record's name in the session's CRM records. */
  readonly nameOf: (entityId: string) => string;
  /** The words a field's evidence covers, when the page holds its utterance. */
  readonly heard?: (evidence: Evidence) => string | undefined;
}

export interface FirstPersonLine {
  /** The loud reason the line speaks for: the tier's first. */
  readonly reason: LoudReason;
  /** The first sentence, which the card's accessible description repeats. */
  readonly lead: string;
  /** What follows it: the choices, or a question. Null when the lead says it all. */
  readonly detail: string | null;
  /** The line as the card shows it. */
  readonly text: string;
}

type Parts = { readonly lead: string; readonly detail: string | null };
type Template = (proposal: VoiceProposal, reason: LoudReason, ctx: VoiceContext) => Parts;

/** "the company" a conflict was about, by the record's kind. */
const CAUGHT: Readonly<Record<EntityKind | "record", string>> = {
  company: "the company",
  contact: "the name",
  deal: "the deal",
  record: "the record",
};

/** "which company you meant", for the linker's question. */
const WHICH: Readonly<Record<EntityKind | "record", string>> = {
  company: "which company you meant",
  contact: "who you meant",
  deal: "which deal you meant",
  record: "which record you meant",
};

/** "the company's name", for a name the transcript doesn't hold. */
const WHOSE_NAME: Readonly<Record<EntityKind | "record", string>> = {
  company: "the company's name",
  contact: "the person's name",
  deal: "the deal's name",
  record: "the record's name",
};

/** "this company", for a new record whose words the card doesn't have. */
const THIS: Readonly<Record<EntityKind | "record", string>> = {
  company: "this company",
  contact: "this person",
  deal: "this deal",
  record: "this record",
};

const DATE_FIELDS = new Set(["dueDate", "closeDate", "date"]);

function kindOf(proposal: VoiceProposal): EntityKind | "record" {
  return proposal.target.kind ?? "record";
}

/** "A", "A or B", "A, B, or C". */
function either(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A field's name inside a sentence: "the due date". */
function fieldWords(field: string | null): string {
  return field === null ? "value" : fieldLabel(field).toLowerCase();
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "the 27th": how a card offers one of a date's readings. */
function ordinalDay(iso: string): string {
  const day = Number(iso.slice(8, 10));
  const teen = day >= 11 && day <= 13;
  const last = day % 10;
  const suffix = teen ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `the ${day}${suffix}`;
}

/** The records a question offers, as names, with a new record as "a new record". */
function offered(proposal: VoiceProposal, ctx: VoiceContext): string[] {
  return askCandidates(proposal.target).map((candidate) =>
    candidate.entityId === null ? "a new record" : ctx.nameOf(candidate.entityId),
  );
}

const witnessConflict: Template = (proposal, reason, ctx) => {
  const conflict = proposal.conflicts.find((c) => c.field === (reason.field ?? "target"));
  const onTarget = reason.field === null || reason.field === "target";
  const lead = onTarget
    ? `I'm not sure I caught ${CAUGHT[kindOf(proposal)]}.`
    : `I'm not sure I caught the ${fieldWords(reason.field)}.`;
  if (conflict?.unbiased) {
    const [a, b] = [conflict.biased.text, conflict.unbiased.text];
    return { lead, detail: onTarget ? `${a} or ${b}?` : `“${a}” or “${b}”?` };
  }
  // Without the witnesses' words, a question still offers its records.
  const names = onTarget && proposal.target.decision === "ask" ? offered(proposal, ctx) : [];
  return { lead, detail: names.length > 1 ? `${capitalized(either(names))}?` : null };
};

const TEMPLATES: Readonly<Record<LoudReasonKind, Template>> = {
  witness_conflict: witnessConflict,
  ask: (proposal, _reason, ctx) => {
    const names = offered(proposal, ctx);
    return {
      lead: `I'm not sure ${WHICH[kindOf(proposal)]}.`,
      detail: names.length > 0 ? `${capitalized(either(names))}?` : null,
    };
  },
  unsupported: (proposal, reason) => {
    if (reason.field === null || reason.field === "target") {
      // The model's words aren't kept once they're found missing, so the line names the kind.
      return {
        lead: `I couldn't find ${WHOSE_NAME[kindOf(proposal)]} in what you said, so I haven't picked a record.`,
        detail: null,
      };
    }
    return {
      lead: `I couldn't find the words for the ${fieldWords(reason.field)} in what you said.`,
      detail: null,
    };
  },
  new_sound_alike: (proposal, _reason, ctx) => {
    const quote = proposal.target.mention?.quote;
    const alikes = proposal.target.candidates
      .filter((candidate) => candidate.entityId !== null && candidate.p >= SOUND_ALIKE_MIN_P)
      .map((candidate) => ctx.nameOf(candidate.entityId as string));
    return {
      lead: quote
        ? `I didn't find “${quote}” in your CRM.`
        : `I didn't find ${THIS[kindOf(proposal)]} in your CRM.`,
      detail: alikes.length > 0 ? `Did you mean ${either(alikes)}, or is it new?` : "Is it new?",
    };
  },
  ambiguous_value: (proposal, reason, ctx) => {
    const field = reason.field === null ? undefined : proposal.fields[reason.field];
    const words = field ? ctx.heard?.(field.evidence) : undefined;
    const readings = (field?.norm?.readings ?? []).map((reading) =>
      typeof reading === "string" && DAY.test(reading)
        ? ordinalDay(reading)
        : spokenValue(reason.field ?? "", reading, field?.norm?.currency),
    );
    return {
      lead: words
        ? `I heard “${words}”.`
        : `I'm not sure which ${fieldWords(reason.field)} you meant.`,
      detail: readings.length > 1 ? `Did you mean ${either(readings)}?` : null,
    };
  },
  value_mismatch: (proposal, reason) => {
    const field = reason.field === null ? undefined : proposal.fields[reason.field];
    const value = field ? spokenValue(reason.field ?? "", field.value, field.norm?.currency) : null;
    const corrected = proposal.riskFlags.some(
      (flag) => flag.kind === "self_correction" && flag.field === reason.field,
    );
    if (corrected) {
      const noun = DATE_FIELDS.has(reason.field ?? "") ? "date" : fieldWords(reason.field);
      return {
        lead:
          value === null
            ? `You corrected yourself here, and I may have kept the first ${noun}.`
            : `You corrected yourself here, and I may have kept the first ${noun}: ${value}.`,
        detail: null,
      };
    }
    const words = fieldWords(reason.field);
    return {
      lead:
        value === null
          ? `I may not have written the ${words} the way you said it.`
          : `I may not have written the ${words} the way you said it: ${value}.`,
      detail: null,
    };
  },
};

/** Every loud reason's template, for the tests: none may be missing. */
export const LOUD_TEMPLATE_KINDS = Object.keys(TEMPLATES) as LoudReasonKind[];

function line(reason: LoudReason, parts: Parts): FirstPersonLine {
  return {
    reason,
    ...parts,
    text: parts.detail === null ? parts.lead : `${parts.lead} ${parts.detail}`,
  };
}

/**
 * The card's first-person line, for the tier's first loud reason; null for a quiet or unmarked
 * card, which never gets one.
 */
export function firstPersonLine(
  proposal: VoiceProposal,
  tier: Tier,
  ctx: VoiceContext,
): FirstPersonLine | null {
  if (tier.tier !== "loud") return null;
  const reason = tier.reasons.find(
    (candidate): candidate is LoudReason => candidate.tier === "loud",
  );
  if (!reason) return null;
  return line(reason, TEMPLATES[reason.kind](proposal, reason, ctx));
}

/**
 * A record offered at review time, which makes a card loud though it isn't a flag (WP12): "Acme
 * Robotics was added to your CRM after you spoke. Is it this one?"
 */
export function relinkLine(recordName: string): Pick<FirstPersonLine, "lead" | "detail" | "text"> {
  const lead = `${recordName} was added to your CRM after you spoke.`;
  const detail = "Is it this one?";
  return { lead, detail, text: `${lead} ${detail}` };
}

/**
 * A 3-way card's line (WP12), on a card no flag makes loud: "The stage changed in your CRM after
 * you spoke. Keep yours or the CRM's?" The spec gives only the field's row ("Discovery when you
 * spoke · Proposal in the CRM now · you said Negotiation"); the line follows the re-link offer's
 * form, and the card's accessible description repeats its first sentence.
 */
export function threeWayLine(fields: string): Pick<FirstPersonLine, "lead" | "detail" | "text"> {
  const lead = `The ${fields} changed in your CRM after you spoke.`;
  const detail = "Keep yours or the CRM's?";
  return { lead, detail, text: `${lead} ${detail}` };
}

/** The record a card is about, for its description: the link, or a question's likeliest record. */
function recordWords(proposal: VoiceProposal, ctx: VoiceContext): string {
  const { target } = proposal;
  switch (target.decision) {
    case "linked":
      return target.entityId === null ? "no record" : ctx.nameOf(target.entityId);
    case "ask": {
      const first = target.candidates[0];
      if (!first) return "a record to choose";
      return first.entityId === null ? "a new record" : ctx.nameOf(first.entityId);
    }
    case "new":
      return "a new record";
    case "none":
      return "no record";
  }
}

/** A loud card's accessible description: "Task, Acme Corp, needs a check: I'm not sure …". */
export function loudDescription(
  proposal: VoiceProposal,
  firstPerson: Pick<FirstPersonLine, "lead">,
  ctx: VoiceContext,
): string {
  return `${PROPOSAL_TYPE_LABELS[proposal.type]}, ${recordWords(proposal, ctx)}, needs a check: ${firstPerson.lead}`;
}
