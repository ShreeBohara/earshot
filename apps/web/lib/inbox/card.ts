// What a card shows (Phase 5 spec WP5 step 3, §4.4), worked out once from a proposal, pure, so the
// card component only lays it out and the tests read it directly:
//
// - the heading: the type and the record, with the name note beside a link that wasn't exact;
// - the loud marker and its first-person line, which is also the card's accessible description;
// - each field as a diff row: the proposed value, the CRM's value as "before" for an update, the
//   words it was heard as, and any note on it;
// - the quiet notes, short and without color;
// - the chooser, numbered 1 to 4: a question's records, or a field's two readings;
// - the correction panel's records, the only place a linked card offers another record, so a stray
//   digit never changes a record;
// - what the CRM's mirror says at review time (WP12, ./crm.ts): a field whose CRM value moved since
//   the proposal shown three ways, with Keep mine and Keep the CRM's, or a record offered on a new
//   record, numbered with "A new record". Either makes the card loud, though neither is a flag.
import type { FieldEdit, FieldValue } from "@earshot/core";
import {
  type LoudReason,
  SOUND_ALIKE_MIN_P,
  type Tier,
  tierOf,
} from "@earshot/understanding/tiers";
import {
  askCandidates,
  fieldLabel,
  NAME_NOTES,
  PROPOSAL_TYPE_LABELS,
  quietNote,
  targetHeading,
} from "@/lib/capture/copy";
import { nameFinder, shownValue } from "./copy";
import {
  currentValue,
  keepCrmDiff,
  type ReviewTimeMark,
  reviewTimeMark,
  type ThreeWayField,
} from "./crm";
import { MAX_CHOICES } from "./keys";
import { agoWords } from "./time";
import type { InboxEntity, InboxProposal } from "./types";
import {
  type FirstPersonLine,
  firstPersonLine,
  loudDescription,
  relinkLine,
  threeWayLine,
  type VoiceContext,
} from "./voice";

type Entities = Readonly<Record<string, InboxEntity>>;
type Quotes = Readonly<Record<string, string>>;

/** One numbered option: a record (a `null` id is a new one), or a value for a field. */
export type ChoiceOption =
  | {
      readonly kind: "record";
      readonly entityId: string | null;
      /** "Dana Li, Akme Dynamics" or "A new record". */
      readonly label: string;
      /** "48%", or "48%, the current record". */
      readonly detail: string;
    }
  | {
      readonly kind: "value";
      readonly field: string;
      readonly value: FieldValue;
      readonly label: string;
      readonly detail: string;
      /** Choosing it keeps the proposed value: an approval, not an edit. */
      readonly keep: boolean;
    };

/** A card's numbered choices, with what they answer. */
export interface Chooser {
  /** The group's name: "Which record?", "Which did you say?", "Which did you mean?". */
  readonly label: string;
  readonly options: readonly ChoiceOption[];
}

/**
 * A field whose CRM value moved since the proposal, as the card shows its three values (WP12):
 * "Discovery when you spoke · Proposal in the CRM now (changed 2 h ago) · you said Negotiation".
 */
export interface ThreeWayRow {
  /** The CRM's value when the rep spoke. */
  readonly base: string;
  /** The CRM's value now. */
  readonly current: string;
  /** What the rep said. */
  readonly proposed: string;
  /** "2 h ago": when the CRM's value last changed, from the page's clock; null without one. */
  readonly ago: string | null;
  /** The row as one sentence, for the copy's tests and the checkpoint. */
  readonly text: string;
}

/** One field, as a diff row. */
export interface FieldRow {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  /** The CRM's value now, for an update, when the mirror has one. */
  readonly before: string | null;
  /** Whether the proposed value differs from `before`. */
  readonly changes: boolean;
  /** The field's three values, when its CRM value moved since the proposal (WP12); else null. */
  readonly threeWay: ThreeWayRow | null;
  /** The words it was heard as. */
  readonly heard: string | null;
  /** A short note on the field: a quiet reason, or a loud one the line doesn't speak for. */
  readonly notes: readonly string[];
}

/**
 * The line a loud card shows, which its accessible description repeats: a flag's first-person line,
 * or a line at review time (WP12) for a 3-way card or a re-link offer, which no flag speaks for.
 */
export interface CardLine extends Pick<FirstPersonLine, "lead" | "detail" | "text"> {
  /** The flag's loud reason the line speaks for; null for a line at review time. */
  readonly reason: LoudReason | null;
  /** What the line is about: `target`, a field's name, or null for the whole card. */
  readonly field: string | null;
}

/** "Keep the CRM's" on a 3-way card (WP12): the fields it sets to the CRM's values now. */
export interface KeepCrm {
  /** The edit, each moved field from the proposed value to the CRM's; empty when they're the same. */
  readonly editDiff: Readonly<Record<string, FieldEdit>>;
  /** "stage", "stage and amount": the fields in words, for its message. */
  readonly words: string;
}

export interface CardModel {
  readonly tier: Tier;
  /** "Task" */
  readonly type: string;
  /** "Acme Corp", "Ask: Acme Dynamics or Akme Dynamics?", "New", "No record". */
  readonly record: string;
  /** "matched by sound" or "matched in context", beside the record's name. */
  readonly nameNote: string | null;
  /** The words that named the record. */
  readonly mention: string | null;
  /** Loud cards only. */
  readonly firstPerson: CardLine | null;
  /**
   * Why the card is loud at review time though no flag says so (WP12): fields shown three ways, or
   * a record offered on a new record. Null otherwise. With it the card is loud (`tier`).
   */
  readonly review: ReviewTimeMark | null;
  /** On a card with fields shown three ways: what "Keep the CRM's" does. Null otherwise. */
  readonly keepCrm: KeepCrm | null;
  /** Loud cards only: "Task, Acme Corp, needs a check: I'm not sure I caught the company." */
  readonly description: string | null;
  readonly fields: readonly FieldRow[];
  /** Quiet notes about the whole card or its record, not one field. */
  readonly notes: readonly string[];
  readonly chooser: Chooser | null;
  /** Whether the chooser picks the record: then it's the card's correction too. */
  readonly choosesRecord: boolean;
  /** The correction panel's records, in the linker's order, with "New" when it offered one. */
  readonly correction: readonly ChoiceOption[];
  /** Whether the card can be accepted as it stands: a question needs a choice, "no record" can't. */
  readonly acceptable: "yes" | "choose" | "no_record";
}

/** A probability as a whole percentage, at least 1% when it isn't 0. */
export function percent(p: number): string {
  return `${p > 0 && p < 0.01 ? 1 : Math.round(p * 100)}%`;
}

/** Notes for loud reasons the first-person line doesn't speak for, on their fields. */
const LOUD_FIELD_NOTES = {
  witness_conflict: "Heard two ways",
  ask: "Pick the record",
  unsupported: "Not backed by what was said",
  new_sound_alike: "Creates a record, though one sounds alike",
  ambiguous_value: "Two readings",
  value_mismatch: "Differs from what was said",
} as const;

function recordOption(
  entityId: string | null,
  p: number,
  entities: Entities,
  current: string | null,
): ChoiceOption {
  if (entityId === null) {
    return { kind: "record", entityId: null, label: "A new record", detail: percent(p) };
  }
  const entity = entities[entityId];
  const account =
    entity && entity.kind !== "company" && entity.accountId
      ? entities[entity.accountId]?.name
      : undefined;
  const name = entity?.name ?? "A CRM record";
  // A deal's name usually carries its company already ("Acme Dynamics - Expansion").
  const named = account !== undefined && name.toLowerCase().includes(account.toLowerCase());
  return {
    kind: "record",
    entityId,
    label: account && !named ? `${name}, ${account}` : name,
    detail: entityId === current ? `${percent(p)}, the current record` : percent(p),
  };
}

/** The chooser, from the first loud reason that has choices to number. */
function chooserOf(
  proposal: InboxProposal,
  tier: Tier,
  entities: Entities,
  heard: (utteranceId: string, span: readonly [number, number]) => string | null,
): { chooser: Chooser | null; choosesRecord: boolean } {
  const { target } = proposal;
  for (const reason of tier.reasons) {
    if (reason.tier !== "loud") continue;
    const onTarget = reason.field === null || reason.field === "target";
    if ((reason.kind === "ask" || reason.kind === "witness_conflict") && onTarget) {
      if (target.decision !== "ask") continue;
      const options = askCandidates(target)
        .slice(0, MAX_CHOICES)
        .map((candidate) => recordOption(candidate.entityId, candidate.p, entities, null));
      if (options.length > 0) {
        return { chooser: { label: "Which record?", options }, choosesRecord: true };
      }
    }
    if (reason.kind === "new_sound_alike" && target.decision === "new") {
      const alikes = target.candidates.filter((candidate) => candidate.entityId !== null);
      const fresh = target.candidates.find((candidate) => candidate.entityId === null);
      const options = [
        ...alikes
          .slice(0, MAX_CHOICES - 1)
          .map((candidate) => recordOption(candidate.entityId, candidate.p, entities, null)),
        recordOption(null, fresh?.p ?? 0, entities, null),
      ];
      return { chooser: { label: "Which record?", options }, choosesRecord: true };
    }
    if (reason.kind === "witness_conflict" && !onTarget && reason.field !== null) {
      const field = proposal.fields[reason.field];
      const conflict = proposal.conflicts.find((candidate) => candidate.field === reason.field);
      if (!field || !conflict?.unbiased) continue;
      const said = conflict.biased.text;
      return {
        chooser: {
          label: "Which did you say?",
          options: [
            {
              kind: "value",
              field: reason.field,
              value: field.value,
              label: `“${said}”`,
              detail: "the live transcript",
              keep: true,
            },
            {
              kind: "value",
              field: reason.field,
              value: conflict.unbiased.text,
              label: `“${conflict.unbiased.text}”`,
              detail: "the second witness",
              keep: conflict.unbiased.text === field.value,
            },
          ],
        },
        choosesRecord: false,
      };
    }
    if (reason.kind === "ambiguous_value" && reason.field !== null) {
      const field = proposal.fields[reason.field];
      const readings = field?.norm?.readings ?? [];
      if (!field || readings.length < 2) continue;
      const words = heard(field.evidence.utteranceId, field.evidence.span);
      return {
        chooser: {
          label: "Which did you mean?",
          options: readings.slice(0, MAX_CHOICES).map((reading) => ({
            kind: "value" as const,
            field: reason.field as string,
            value: reading,
            label: shownValue(reason.field as string, reading, field.norm?.currency),
            detail: words ? `from “${words}”` : "one reading",
            keep: reading === field.value,
          })),
        },
        choosesRecord: false,
      };
    }
  }
  return { chooser: null, choosesRecord: false };
}

/** "stage", "stage and amount", "stage, amount, and close date". */
function fieldsWords(fields: readonly Pick<ThreeWayField, "field">[]): string {
  const words = fields.map((field) => fieldLabel(field.field).toLowerCase());
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

/**
 * The record offered at review time, first, as the card numbers it (WP12): then its sound-alikes,
 * as a new record with one numbers them, and "A new record" last.
 */
function relinkChooser(proposal: InboxProposal, entityId: string, entities: Entities): Chooser {
  const offered = recordOption(entityId, 1, entities, null);
  const alikes = proposal.target.candidates
    .filter(
      (candidate) =>
        candidate.entityId !== null &&
        candidate.entityId !== entityId &&
        candidate.p >= SOUND_ALIKE_MIN_P,
    )
    .slice(0, MAX_CHOICES - 2)
    .map((candidate) => recordOption(candidate.entityId, candidate.p, entities, null));
  const fresh = proposal.target.candidates.find((candidate) => candidate.entityId === null);
  return {
    label: "Which record?",
    options: [
      { ...offered, detail: "added after you spoke" },
      ...alikes,
      recordOption(null, fresh?.p ?? 0, entities, null),
    ],
  };
}

/**
 * Everything a card shows, from its proposal and the records and words the page loaded. `now` is
 * the page's clock, which says how long ago a CRM value moved (WP12); without it, the card doesn't
 * say.
 */
export function cardModel(
  proposal: InboxProposal,
  entities: Entities,
  quotes: Quotes,
  now?: number,
): CardModel {
  const nameOf = nameFinder(entities);
  const heardSpan = (utteranceId: string, span: readonly [number, number]) =>
    quotes[utteranceId]?.slice(span[0], span[1]) || null;
  const ctx: VoiceContext = {
    nameOf: (entityId) => entities[entityId]?.name ?? "a CRM record",
    heard: (evidence) => heardSpan(evidence.utteranceId, evidence.span) ?? undefined,
  };
  const flagged = tierOf(proposal);
  const review = reviewTimeMark(proposal, entities);
  // Loud at review time too (WP12), though no flag says so: its reasons stay the flags'.
  const tier: Tier = review && flagged.tier !== "loud" ? { ...flagged, tier: "loud" } : flagged;
  const flagLine = firstPersonLine(proposal, flagged, ctx);
  const threeWay = review?.kind === "crm_changed" ? review.fields : [];
  const firstPerson: CardLine | null =
    review?.kind === "relink"
      ? { ...relinkLine(nameOf(review.entityId)), reason: null, field: "target" }
      : flagLine
        ? { ...flagLine, field: flagLine.reason.field }
        : review?.kind === "crm_changed"
          ? {
              ...threeWayLine(fieldsWords(threeWay)),
              reason: null,
              field: threeWay[0]?.field ?? null,
            }
          : null;
  const { target } = proposal;

  // Each note on its field, or on the card for the record and the whole proposal.
  const fieldNotes = new Map<string, string[]>();
  const cardNotes: string[] = [];
  const note = (field: string | null, text: string) => {
    if (field === null || field === "target" || !(field in proposal.fields)) {
      if (!cardNotes.includes(text)) cardNotes.push(text);
      return;
    }
    const list = fieldNotes.get(field) ?? [];
    if (!list.includes(text)) list.push(text);
    fieldNotes.set(field, list);
  };
  for (const reason of tier.reasons) {
    if (reason.tier === "quiet") {
      note(reason.field, quietNote(reason, proposal.fields, ctx.heard));
    } else if (
      reason !== firstPerson?.reason &&
      reason.field !== null &&
      reason.field !== "target"
    ) {
      note(reason.field, LOUD_FIELD_NOTES[reason.kind]);
    }
  }

  const moved = new Map(threeWay.map((field) => [field.field, field]));
  const fields: FieldRow[] = Object.entries(proposal.fields).map(([name, field]) => {
    const before = currentValue(proposal, name, entities);
    const value = shownValue(name, field.value, field.norm?.currency);
    const change = moved.get(name);
    let threeWayRow: ThreeWayRow | null = null;
    if (change) {
      const base = shownValue(name, change.base);
      const current = shownValue(name, change.current);
      const ago = now === undefined ? null : agoWords(new Date(change.changedAt), new Date(now));
      threeWayRow = {
        base,
        current,
        proposed: value,
        ago,
        text: `${base} when you spoke · ${current} in the CRM now${ago ? ` (changed ${ago})` : ""} · you said ${value}`,
      };
    }
    return {
      name,
      label: fieldLabel(name),
      value,
      before: before === undefined ? null : shownValue(name, before),
      changes: before === undefined || before !== field.value,
      threeWay: threeWayRow,
      heard: heardSpan(field.evidence.utteranceId, field.evidence.span),
      notes: fieldNotes.get(name) ?? [],
    };
  });

  const relinked = review?.kind === "relink" ? review.entityId : null;
  const { chooser, choosesRecord } =
    relinked !== null
      ? { chooser: relinkChooser(proposal, relinked, entities), choosesRecord: true }
      : chooserOf(proposal, tier, entities, heardSpan);
  const current = target.decision === "linked" ? target.entityId : null;
  const correction = choosesRecord
    ? []
    : [
        ...target.candidates
          .filter((candidate) => candidate.entityId !== null)
          .slice(0, MAX_CHOICES - 1)
          .map((candidate) => recordOption(candidate.entityId, candidate.p, entities, current)),
        ...target.candidates
          .filter((candidate) => candidate.entityId === null)
          .slice(0, 1)
          .map((candidate) => recordOption(null, candidate.p, entities, current)),
      ];

  return {
    tier,
    type: PROPOSAL_TYPE_LABELS[proposal.type],
    record: targetHeading(target, nameOf),
    nameNote: tier.nameNote ? NAME_NOTES[tier.nameNote] : null,
    mention: target.mention?.quote ?? null,
    firstPerson,
    description: firstPerson ? loudDescription(proposal, firstPerson, ctx) : null,
    review,
    keepCrm:
      threeWay.length > 0
        ? { editDiff: keepCrmDiff(threeWay), words: fieldsWords(threeWay) }
        : null,
    fields,
    notes: cardNotes,
    chooser,
    choosesRecord,
    correction,
    // A record offered at review time asks "Is it this one?": it needs an answer, as a question does.
    acceptable:
      target.decision === "none"
        ? "no_record"
        : target.decision === "ask" || relinked !== null
          ? "choose"
          : "yes",
  };
}
