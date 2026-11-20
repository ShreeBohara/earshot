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
//   digit never changes a record.
import type { FieldValue } from "@earshot/core";
import { type Tier, tierOf } from "@earshot/understanding/tiers";
import {
  askCandidates,
  fieldLabel,
  NAME_NOTES,
  PROPOSAL_TYPE_LABELS,
  quietNote,
  targetHeading,
} from "@/lib/capture/copy";
import { nameFinder, shownValue } from "./copy";
import { MAX_CHOICES } from "./keys";
import { beforeValue } from "./review";
import type { InboxEntity, InboxProposal } from "./types";
import { type FirstPersonLine, firstPersonLine, loudDescription, type VoiceContext } from "./voice";

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

/** One field, as a diff row. */
export interface FieldRow {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  /** The CRM's value now, for an update, when the mirror has one. */
  readonly before: string | null;
  /** Whether the proposed value differs from `before`. */
  readonly changes: boolean;
  /** The words it was heard as. */
  readonly heard: string | null;
  /** A short note on the field: a quiet reason, or a loud one the line doesn't speak for. */
  readonly notes: readonly string[];
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
  readonly firstPerson: FirstPersonLine | null;
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

/** Everything a card shows, from its proposal and the records and words the page loaded. */
export function cardModel(proposal: InboxProposal, entities: Entities, quotes: Quotes): CardModel {
  const nameOf = nameFinder(entities);
  const heardSpan = (utteranceId: string, span: readonly [number, number]) =>
    quotes[utteranceId]?.slice(span[0], span[1]) || null;
  const ctx: VoiceContext = {
    nameOf: (entityId) => entities[entityId]?.name ?? "a CRM record",
    heard: (evidence) => heardSpan(evidence.utteranceId, evidence.span) ?? undefined,
  };
  const tier = tierOf(proposal);
  const firstPerson = firstPersonLine(proposal, tier, ctx);
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

  const fields: FieldRow[] = Object.entries(proposal.fields).map(([name, field]) => {
    const before = beforeValue(proposal, name, entities);
    return {
      name,
      label: fieldLabel(name),
      value: shownValue(name, field.value, field.norm?.currency),
      before: before === undefined ? null : shownValue(name, before),
      changes: before === undefined || before !== field.value,
      heard: heardSpan(field.evidence.utteranceId, field.evidence.span),
      notes: fieldNotes.get(name) ?? [],
    };
  });

  const { chooser, choosesRecord } = chooserOf(proposal, tier, entities, heardSpan);
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
    fields,
    notes: cardNotes,
    chooser,
    choosesRecord,
    correction,
    acceptable:
      target.decision === "none" ? "no_record" : target.decision === "ask" ? "choose" : "yes",
  };
}
