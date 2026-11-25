// What each proposal writes (Phase 6 spec §4.3, decisions 7, 15 to 17; docs/adr/0041): §4.3's table
// as data. The rows are the same for every CRM: for each proposal type and target case, which
// writes, in what order, carrying which of the proposal's values, with which live checks. Each
// adapter fills in its column (`PlanColumn`): the CRM's property names and value forms for each
// kind of write, its names for the checked fields, and its limits. `buildPlan` reads both into a
// `WritePlan`, pure and synchronous, so the dry run, the outbox's write steps, and the golden tests
// all get the same plan from the same input.
//
// The rows:
//
// | Proposal | Linked record | New record |
// |---|---|---|
// | Note | a note on the record | the record, then a note on it |
// | Task | a task on the record, assigned to the rep where the CRM has owners | the record, then the task |
// | Contact | an update of its title, email, and phone, after live checks | the person, linked to their company |
// | Deal update | an update of its stage, amount, and close date, after live checks | the deal, in the new deals' pipeline, linked to its company |
// | Commitment | a task ("Commitment: …") when it has a due date and the mapping says tasks; otherwise a note | the record, then the same |
// | Meeting | a meeting where the CRM has them and the mapping says so; otherwise a note ("Meeting: …") | the record, then the same |
//
// A new record is the plan's first write, and later writes point at it (`{ write: 0 }`). Every
// activity ends with the line "via Earshot · ref es_…" (decision 17); records carry their marker in
// a property instead, as each column decides. Associations are set on the create when the CRM
// takes them inline; otherwise each record's associations are a write of their own, right after it.
import type { CrmMappedStage, CrmObject, FieldValue } from "@earshot/core";
import { containsKeyShape, MAX_SYNC_WRITES } from "@earshot/core";
import type {
  Capabilities,
  CrmSchema,
  CrmValue,
  LiveCheck,
  PlanInput,
  PlannedWrite,
  PlanRefusal,
  PlanResult,
  WriteRef,
} from "../adapter";
import { withActivityLine } from "./line";
import { splitName } from "./names";
import { readStage } from "./stages";
import {
  DUE_TIME,
  dueInstant,
  isCalendarDay,
  isClockTime,
  knownTimeZone,
  zonedInstant,
} from "./time";
import { approvedValues, seenValue, textOf } from "./values";

/** The kinds of record a proposal targets. */
export type RecordObject = Extract<CrmObject, "company" | "contact" | "deal">;
/** The kinds of activity a sync writes. */
export type ActivityObject = Extract<CrmObject, "note" | "task" | "meeting">;

/** A new company: its name, as the rep said it. */
export interface CompanyValues {
  readonly name: string;
}

/**
 * A person: a new one's name (whole, and split by `splitName`) and details; for an update, only
 * the details the proposal holds (`name` and its parts are absent then).
 */
export interface ContactValues {
  readonly name?: string;
  readonly firstName?: string;
  readonly lastName?: string | null;
  readonly title?: string;
  readonly email?: string;
  readonly phone?: string;
}

/**
 * A deal: a new one's name (the words that named it) and pipeline; for both, the stage the mapping
 * read, the amount (US dollars), and the close date (`YYYY-MM-DD`), each only when the proposal
 * holds it. A new deal always has a stage: the one the rep named, or its pipeline's first.
 */
export interface DealValues {
  readonly name?: string;
  readonly pipelineId?: string | null;
  readonly stage?: CrmMappedStage;
  readonly amount?: number;
  readonly closeDate?: string;
}

/** A note: its text, which ends with the activity line, and when it happened (the proposal's time). */
export interface NoteValues {
  readonly body: string;
  readonly at: string;
}

/**
 * A task: its title; a body that ends with the activity line; when it's due (its due date at 09:00
 * in the rep's zone, or the proposal's time when it has none); the due date as said; and the CRM
 * owner it's assigned to (null where the CRM has no owners or the mapping names none).
 */
export interface TaskValues {
  readonly title: string;
  readonly body: string;
  readonly dueAt: string;
  readonly dueDate: string | null;
  readonly ownerId: string | null;
}

/**
 * A meeting: its title; a body (the attendees as said) that ends with the activity line; and when
 * it starts in the rep's zone: its date and time, its date at 09:00 when no time was said, or the
 * proposal's time when no date was.
 */
export interface MeetingValues {
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
}

/** One write in Earshot's own terms, before a column names the CRM's properties. */
export type Draft =
  | { readonly object: "company"; readonly op: "create"; readonly values: CompanyValues }
  | { readonly object: "contact"; readonly op: "create" | "update"; readonly values: ContactValues }
  | { readonly object: "deal"; readonly op: "create" | "update"; readonly values: DealValues }
  | { readonly object: "note"; readonly op: "create"; readonly values: NoteValues }
  | { readonly object: "task"; readonly op: "create"; readonly values: TaskValues }
  | { readonly object: "meeting"; readonly op: "create"; readonly values: MeetingValues };

/** The fields each record kind's live checks read (§4.3): what the reviewer saw, held to the CRM. */
export const CHECKED_FIELDS = {
  deal: ["stage", "amount", "closeDate"],
  contact: ["title", "email", "phone"],
} as const satisfies Readonly<Record<"deal" | "contact", readonly string[]>>;

/** A checked field of a deal or a contact. */
export type CheckedField = (typeof CHECKED_FIELDS)[keyof typeof CHECKED_FIELDS][number];

/** An adapter's column of the table: how its CRM holds each kind of write. */
export interface PlanColumn {
  /** The CRM's name, for a refusal's words ("HubSpot has no stage like …"). */
  readonly crm: string;
  readonly capabilities: Capabilities;
  /**
   * A write's properties as the CRM takes them, by its own names and in its own forms, from the
   * write's values and its marker: the marker goes in a property of a record the CRM finds it by
   * (`upsert`, `readback`), or nowhere; an activity's marker is already in its body's line.
   */
  properties(draft: Draft, marker: string): Readonly<Record<string, CrmValue>>;
  /** The CRM's name for a field a live check reads: HubSpot's `dealstage` for a deal's `stage`. */
  checkField(object: "deal" | "contact", field: CheckedField): string;
  /**
   * The association type from one kind of record to another, when the schema doesn't list it (a
   * CRM's documented defaults); null when there's none. The schema's own list is read first.
   */
  associationType?(from: CrmObject, to: CrmObject, schema: CrmSchema): string | number | null;
  /** The most characters an activity's body may hold, where the CRM caps it (Attio tasks: 2,000). */
  readonly maxBodyChars?: Partial<Readonly<Record<ActivityObject, number>>>;
}

/** A refusal: the job fails with it before any write. */
type Refusal = Extract<PlanResult, { ok: false }>;

function refuse(kind: PlanRefusal, field: string | null, reason: string): Refusal {
  return { ok: false, kind, field, reason };
}

/**
 * A write before its place in the plan is known: records as they'll be written, and activities
 * with their text, which gets its line once the write's marker is known.
 */
type Pending =
  | Extract<Draft, { object: RecordObject }>
  | { readonly object: "note"; readonly text: string; readonly values: Omit<NoteValues, "body"> }
  | {
      readonly object: "task";
      readonly text: string | null;
      readonly values: Omit<TaskValues, "body">;
    }
  | {
      readonly object: "meeting";
      readonly text: string | null;
      readonly values: Omit<MeetingValues, "body">;
    };

/** A pending write with what it points at: the record it updates, and what it's linked to. */
interface Step {
  readonly pending: Pending;
  /** The record an update changes. */
  readonly ref: WriteRef | null;
  /** What the record is linked to: an activity's record, a person's or a deal's company. */
  readonly links: readonly { readonly ref: WriteRef; readonly object: CrmObject }[];
}

/** A refusal, or the steps and checks a proposal plans to. */
type Drafted =
  | { readonly ok: true; readonly steps: readonly Step[]; readonly checks: readonly LiveCheck[] }
  | Refusal;

/** The longest words a refusal quotes back. */
const MAX_QUOTED_CHARS = 60;

/** A rep's words for a refusal, quoted, or "that" when they're too long or shaped like a key. */
function quoted(words: string): string {
  if (words.length > MAX_QUOTED_CHARS || containsKeyShape(words)) return "that";
  return `"${words}"`;
}

/** A pending write as the column sees it: an activity's text with the line for its marker. */
function finish(pending: Pending, marker: string, column: PlanColumn): Draft {
  switch (pending.object) {
    case "company":
    case "contact":
    case "deal":
      return pending;
    case "note":
      return {
        object: "note",
        op: "create",
        values: {
          ...pending.values,
          body: withActivityLine(pending.text, marker, column.maxBodyChars?.note),
        },
      };
    case "task":
      return {
        object: "task",
        op: "create",
        values: {
          ...pending.values,
          body: withActivityLine(pending.text, marker, column.maxBodyChars?.task),
        },
      };
    case "meeting":
      return {
        object: "meeting",
        op: "create",
        values: {
          ...pending.values,
          body: withActivityLine(pending.text, marker, column.maxBodyChars?.meeting),
        },
      };
  }
}

/**
 * The plan for an approval, by §4.3's table and the adapter's column; or the refusal that fails the
 * job before any write (`unmapped`, `unsupported`, or `validation`, with the field to blame). Pure.
 * Throws a `TypeError` when the input hasn't a marker for each write, which is the caller's bug.
 */
export function buildPlan(input: PlanInput, column: PlanColumn): PlanResult {
  const drafted = draft(input, column);
  if (!drafted.ok) return drafted;
  const inline = column.capabilities.associations === "inline";
  const writes: PlannedWrite[] = [];
  // Where each step's own write landed, so later steps can point at it.
  const placed: number[] = [];
  const resolve = (ref: WriteRef): WriteRef =>
    "write" in ref ? { write: placed[ref.write] as number } : ref;
  const markerAt = (index: number): string => {
    const marker = input.markers[index];
    if (marker === undefined) {
      throw new TypeError(`PlanInput.markers has no marker for write ${index}`);
    }
    return marker;
  };

  for (const step of drafted.steps) {
    const { object } = step.pending;
    const links: { to: WriteRef; type: string | number }[] = [];
    for (const link of step.links) {
      const type = associationType(object, link.object, input.schema, column);
      if (type === null) {
        return refuse(
          "unsupported",
          null,
          `${column.crm} has no link from a ${object} to a ${link.object}`,
        );
      }
      links.push({ to: resolve(link.ref), type });
    }
    const index = writes.length;
    const marker = markerAt(index);
    const made = finish(step.pending, marker, column);
    placed.push(index);
    writes.push({
      index,
      op: made.op,
      object,
      marker,
      ref: step.ref === null ? null : resolve(step.ref),
      properties: column.properties(made, marker),
      associate: inline ? links : [],
    });
    if (!inline && links.length > 0) {
      const at = writes.length;
      writes.push({
        index: at,
        op: "associate",
        object,
        marker: markerAt(at),
        ref: { write: index },
        properties: {},
        associate: links,
      });
    }
  }
  if (writes.length > MAX_SYNC_WRITES) {
    throw new RangeError(`a plan holds at most ${MAX_SYNC_WRITES} writes, not ${writes.length}`);
  }
  return { ok: true, plan: { v: 1, checks: [...drafted.checks], writes } };
}

/** The association type from one kind to another: the schema's, else the column's default. */
function associationType(
  from: CrmObject,
  to: CrmObject,
  schema: CrmSchema,
  column: PlanColumn,
): string | number | null {
  const listed = schema.associations.find((type) => type.from === from && type.to === to);
  if (listed) return listed.type;
  return column.associationType?.(from, to, schema) ?? null;
}

/** The steps and checks for a proposal, by its type and whether its record is new. */
function draft(input: PlanInput, column: PlanColumn): Drafted {
  const { proposal } = input;
  const values = approvedValues(proposal, input.review);
  switch (proposal.type) {
    case "contact":
      return input.target === null
        ? newContact(input, values, column)
        : updateRecord(input, "contact", values, column);
    case "deal_update":
      return input.target === null
        ? newDeal(input, values, column)
        : updateRecord(input, "deal", values, column);
    case "note":
    case "task":
    case "commitment":
    case "meeting": {
      const activity = activityStep(input, values, column);
      if (!activity.ok) return activity;
      const target = targetSteps(input, column);
      if (!target.ok) return target;
      return {
        ok: true,
        steps: [
          ...target.steps,
          {
            pending: activity.pending,
            ref: null,
            links: [{ ref: target.ref, object: target.object }],
          },
        ],
        checks: [],
      };
    }
  }
}

/** The record an activity goes on: the linked record, or a new one made first. */
function targetSteps(
  input: PlanInput,
  column: PlanColumn,
):
  | {
      readonly ok: true;
      readonly steps: readonly Step[];
      readonly ref: WriteRef;
      readonly object: RecordObject;
    }
  | Refusal {
  if (input.target !== null) {
    const { object } = input.target.ref;
    if (object !== "company" && object !== "contact" && object !== "deal") {
      return refuse("validation", "target", "An activity goes on a company, a contact, or a deal");
    }
    return { ok: true, steps: [], ref: input.target.ref, object };
  }
  const { kind, mention } = input.proposal.target;
  const name = textOf(mention?.quote);
  if (kind === null || name === null) {
    return refuse("validation", "target", "The new record has no name");
  }
  if (!column.capabilities.objects[kind]) {
    return refuse("unsupported", "target", `${column.crm} has no ${kind}s`);
  }
  let made: Pending;
  switch (kind) {
    case "company":
      made = { object: "company", op: "create", values: { name } };
      break;
    case "contact":
      made = { object: "contact", op: "create", values: personName(name) };
      break;
    case "deal": {
      const stage = newDealStage(input, undefined, column);
      if (!stage.ok) return stage;
      made = {
        object: "deal",
        op: "create",
        values: { name, pipelineId: stage.pipelineId, stage: stage.stage },
      };
      break;
    }
  }
  return {
    ok: true,
    steps: [{ pending: made, ref: null, links: companyLink(input, kind) }],
    ref: { write: 0 },
    object: kind,
  };
}

/** A new person's or deal's company, when the proposal's company is a record the CRM has. */
function companyLink(input: PlanInput, kind: RecordObject): Step["links"] {
  if (kind === "company" || input.company === null) return [];
  return [{ ref: input.company.ref, object: "company" }];
}

/** A whole name and its parts, by `splitName`. */
function personName(name: string): ContactValues {
  const parts = splitName(name);
  return { name, firstName: parts?.first ?? name, lastName: parts?.last ?? null };
}

/** A new contact: the person, with their details, linked to their company. */
function newContact(
  input: PlanInput,
  values: Readonly<Record<string, FieldValue>>,
  column: PlanColumn,
): Drafted {
  const name = textOf(values.name);
  if (name === null) return refuse("validation", "name", "The new contact has no name");
  if (!column.capabilities.objects.contact) {
    return refuse("unsupported", null, `${column.crm} has no contacts`);
  }
  return {
    ok: true,
    steps: [
      {
        pending: {
          object: "contact",
          op: "create",
          values: { ...personName(name), ...contactDetails(values) },
        },
        ref: null,
        links: companyLink(input, "contact"),
      },
    ],
    checks: [],
  };
}

/** A person's details the proposal holds: title, email, and phone. */
function contactDetails(values: Readonly<Record<string, FieldValue>>): ContactValues {
  const title = textOf(values.title);
  const email = textOf(values.email);
  const phone = textOf(values.phone);
  return {
    ...(title === null ? {} : { title }),
    ...(email === null ? {} : { email }),
    ...(phone === null ? {} : { phone }),
  };
}

/** A deal's values the proposal holds, checked: the stage read by the mapping, amount, close date. */
function dealValues(
  input: PlanInput,
  values: Readonly<Record<string, FieldValue>>,
  column: PlanColumn,
  pipelineId: string | null | undefined,
): { readonly ok: true; readonly values: DealValues } | Refusal {
  const out: { -readonly [K in keyof DealValues]: DealValues[K] } = {};
  const words = textOf(values.stage);
  if (words !== null) {
    const reading = readStage(words, input.mapping.stages, { pipelineId });
    if (!reading.ok) {
      const reason =
        reading.reason === "ambiguous"
          ? `${column.crm} has more than one stage like ${quoted(words)}`
          : `${column.crm} has no stage like ${quoted(words)}`;
      return refuse("unmapped", "stage", reason);
    }
    out.stage = reading.stage;
  }
  const { amount, closeDate } = values;
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return refuse("validation", "amount", "The amount isn't a sum of money");
    }
    out.amount = amount;
  }
  if (closeDate !== undefined && closeDate !== null) {
    if (!isCalendarDay(closeDate)) {
      return refuse("validation", "closeDate", "The close date isn't a date");
    }
    out.closeDate = closeDate;
  }
  return { ok: true, values: out };
}

/** The stage a new deal gets, in the new deals' pipeline: the one the rep named, or its first. */
function newDealStage(
  input: PlanInput,
  named: CrmMappedStage | undefined,
  column: PlanColumn,
):
  | { readonly ok: true; readonly stage: CrmMappedStage; readonly pipelineId: string | null }
  | Refusal {
  const { pipelineId } = input.mapping.newDeals;
  const stage =
    named ??
    input.mapping.stages.find(
      (candidate) => pipelineId === null || candidate.pipelineId === pipelineId,
    );
  if (stage === undefined) {
    return refuse("unmapped", "stage", `${column.crm} has no stage for new deals`);
  }
  return { ok: true, stage, pipelineId: pipelineId ?? stage.pipelineId };
}

/** A new deal: named by the words that named it, in the new deals' pipeline, linked to its company. */
function newDeal(
  input: PlanInput,
  values: Readonly<Record<string, FieldValue>>,
  column: PlanColumn,
): Drafted {
  if (!column.capabilities.objects.deal) {
    return refuse("unsupported", null, `${column.crm} has no deals`);
  }
  const name = textOf(input.proposal.target.mention?.quote);
  if (name === null) return refuse("validation", "target", "The new deal has no name");
  const read = dealValues(input, values, column, input.mapping.newDeals.pipelineId);
  if (!read.ok) return read;
  const stage = newDealStage(input, read.values.stage, column);
  if (!stage.ok) return stage;
  return {
    ok: true,
    steps: [
      {
        pending: {
          object: "deal",
          op: "create",
          values: { ...read.values, name, pipelineId: stage.pipelineId, stage: stage.stage },
        },
        ref: null,
        links: companyLink(input, "deal"),
      },
    ],
    checks: [],
  };
}

/** An update of a linked contact or deal, with a live check of each field it changes. */
function updateRecord(
  input: PlanInput,
  object: "contact" | "deal",
  values: Readonly<Record<string, FieldValue>>,
  column: PlanColumn,
): Drafted {
  const { target } = input;
  if (target === null) throw new TypeError("updateRecord needs a target");
  if (target.ref.object !== object) {
    return refuse("validation", "target", `The record isn't a ${object}`);
  }
  let pending: Pending;
  if (object === "contact") {
    pending = { object, op: "update", values: contactDetails(values) };
  } else {
    const read = dealValues(input, values, column, undefined);
    if (!read.ok) return read;
    pending = { object, op: "update", values: read.values };
  }
  const written = pending.values as Readonly<Record<string, unknown>>;
  const changed = CHECKED_FIELDS[object].filter((field) => written[field] !== undefined);
  if (changed.length === 0) {
    return refuse("validation", null, `Nothing to change on ${target.name} in ${column.crm}`);
  }
  const checks: LiveCheck[] = [];
  for (const field of changed) {
    const seen = seenValue(input.review, field);
    if (seen === undefined) continue;
    checks.push({ ref: target.ref, field, crmField: column.checkField(object, field), seen });
  }
  return { ok: true, steps: [{ pending, ref: target.ref, links: [] }], checks };
}

/** The activity an activity proposal writes, by its type, the mapping, and the CRM. */
function activityStep(
  input: PlanInput,
  values: Readonly<Record<string, FieldValue>>,
  column: PlanColumn,
): { readonly ok: true; readonly pending: Pending } | Refusal {
  const { capabilities } = column;
  const zone = knownTimeZone(input.rep.timeZone);
  const at = input.proposal.ts;
  const ownerId = capabilities.owners ? input.rep.ownerId : null;
  const day = (field: string): { readonly date: string | null } | Refusal => {
    const value = values[field];
    if (value === undefined || value === null) return { date: null };
    return isCalendarDay(value)
      ? { date: value }
      : refuse("validation", field, `The ${field === "date" ? "date" : "due date"} isn't a date`);
  };
  let pending: Pending;

  switch (input.proposal.type) {
    case "note": {
      const body = textOf(values.body);
      if (body === null) return refuse("validation", "body", "The note is empty");
      pending = { object: "note", text: body, values: { at } };
      break;
    }
    case "task": {
      const title = textOf(values.title);
      if (title === null) return refuse("validation", "title", "The task has no title");
      const due = day("dueDate");
      if ("ok" in due) return due;
      pending = {
        object: "task",
        text: null,
        values: {
          title,
          dueAt: due.date === null ? at : (dueInstant(due.date, zone) as string),
          dueDate: due.date,
          ownerId,
        },
      };
      break;
    }
    case "commitment": {
      const text = textOf(values.text);
      if (text === null) return refuse("validation", "text", "The commitment is empty");
      const due = day("dueDate");
      if ("ok" in due) return due;
      const counterpart = textOf(values.counterpart);
      const withWho = counterpart === null ? null : `Counterpart: ${counterpart}`;
      const asTask =
        due.date !== null &&
        input.mapping.destinations.commitment === "task" &&
        capabilities.objects.task;
      if (asTask && due.date !== null) {
        pending = {
          object: "task",
          text: withWho,
          values: {
            title: `Commitment: ${text}`,
            dueAt: dueInstant(due.date, zone) as string,
            dueDate: due.date,
            ownerId,
          },
        };
      } else {
        const lines = [
          `Commitment: ${text}`,
          withWho,
          due.date === null ? null : `Due: ${due.date}`,
        ];
        pending = { object: "note", text: joinLines(lines), values: { at } };
      }
      break;
    }
    case "meeting": {
      const title = textOf(values.title);
      if (title === null) return refuse("validation", "title", "The meeting has no title");
      const date = day("date");
      if ("ok" in date) return date;
      const { time } = values;
      if (time !== undefined && time !== null && !isClockTime(time)) {
        return refuse("validation", "time", "The time isn't a time of day");
      }
      const clock = typeof time === "string" ? time : null;
      const attendees = textOf(values.attendees);
      const asMeeting =
        input.mapping.destinations.meeting === "meeting" && capabilities.objects.meeting;
      if (asMeeting) {
        const startsAt =
          date.date === null ? at : (zonedInstant(date.date, clock ?? DUE_TIME, zone) as string);
        pending = {
          object: "meeting",
          text: attendees === null ? null : `Attendees: ${attendees}`,
          values: { title, startsAt },
        };
      } else {
        const when =
          date.date === null
            ? null
            : `When: ${date.date}${clock === null ? "" : ` ${clock}`} (${zone})`;
        const lines = [
          `Meeting: ${title}`,
          when,
          attendees === null ? null : `Attendees: ${attendees}`,
        ];
        pending = { object: "note", text: joinLines(lines), values: { at } };
      }
      break;
    }
    default:
      throw new TypeError(`${input.proposal.type} isn't an activity`);
  }
  if (!capabilities.objects[pending.object]) {
    return refuse("unsupported", null, `${column.crm} has no ${pending.object}s`);
  }
  return { ok: true, pending };
}

/** Lines of an activity's text, without the ones that say nothing. */
function joinLines(lines: readonly (string | null)[]): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}
