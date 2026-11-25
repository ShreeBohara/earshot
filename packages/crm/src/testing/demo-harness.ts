// The conformance suite's harness for the demo CRM (Phase 6 WP2): fixtures made as the dataset's
// rows are, records read back raw, and edits and deletes behind Earshot's back, over raw operations
// on whichever store backs it: memory here (`memoryDemoRaw`), Postgres in `@earshot/db`'s tests.
// The demo CRM takes no credential, can't be rate-limited, keeps no deleted rows, and has no
// users: the suite's options say so. Worker-safe.
import type { CrmObject, ExternalRef, FieldValue } from "@earshot/core";
import type { CrmContext, CrmValue } from "../adapter";
import type {
  DemoActivity,
  DemoActivityKind,
  DemoRecord,
  DemoRecordKind,
  DemoValue,
} from "../demo/store";
import type { MemoryDemoStore } from "./demo-store";
import type { ConformanceHarness, FixtureEdit, Made, MirrorValues, RawRecord } from "./harness";

/** What the demo harness needs from a store besides `DemoStore`: a CRM user's own hands on it. */
export interface DemoRaw {
  /** Makes a record as the dataset's are made: a demo row, outside the adapter. */
  insert(
    kind: DemoRecordKind,
    name: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): Promise<DemoRecord>;
  read(kind: DemoRecordKind, id: string): Promise<DemoRecord | null>;
  /** Every record of a kind holding a marker. */
  withWriteId(kind: DemoRecordKind, writeId: string): Promise<DemoRecord[]>;
  /** Every activity of a kind holding a marker. */
  activitiesWithWriteId(kind: DemoActivityKind, writeId: string): Promise<DemoActivity[]>;
  /** An activity, by its kind and id. */
  activity(kind: DemoActivityKind, id: string): Promise<DemoActivity | null>;
  /** A CRM user's edit of a record's properties (`name` for its name). */
  update(
    kind: DemoRecordKind,
    id: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): Promise<DemoRecord>;
  remove(kind: DemoRecordKind, id: string): Promise<void>;
}

function isRecordKind(object: CrmObject): object is DemoRecordKind {
  return object === "company" || object === "contact" || object === "deal";
}

/** A demo record's values as the mirror holds them: its own properties, a stage by its id. */
export function demoMirrorValues(record: DemoRecord): MirrorValues {
  const value = (field: string): FieldValue => record.properties[field] ?? null;
  switch (record.kind) {
    case "deal":
      return { stage: value("stage"), amount: value("amount"), closeDate: value("closeDate") };
    case "contact":
      return { title: value("title"), email: value("email"), phone: value("phone") };
    default:
      return {};
  }
}

const refOf = (object: CrmObject, id: string): ExternalRef => ({ object, id, url: null });

/** A record as the demo API takes its properties: its name among them. */
function rawRecord(record: DemoRecord): RawRecord {
  return {
    ref: refOf(record.kind, record.id),
    properties: { name: record.name, ...record.properties },
  };
}

/** An activity as the demo API takes its properties. */
function rawActivity(activity: DemoActivity): RawRecord {
  const properties: Record<string, CrmValue> = { body: activity.body };
  if (activity.dueAt !== null) properties.dueAt = activity.dueAt;
  if (activity.startsAt !== null) properties.startsAt = activity.startsAt;
  return { ref: refOf(activity.kind, activity.id), properties };
}

const EDIT_PROPERTY: Readonly<Record<FixtureEdit["field"], string>> = {
  name: "name",
  stage: "stage",
  amount: "amount",
  closeDate: "closeDate",
  title: "title",
  email: "email",
  phone: "phone",
};

/** The demo CRM's harness, over a context to call it through and raw operations on its store. */
export function demoHarness(parts: {
  readonly context: () => CrmContext;
  readonly raw: DemoRaw;
  readonly setup?: () => Promise<void>;
  readonly teardown?: () => Promise<void>;
}): ConformanceHarness {
  const { raw } = parts;
  return {
    ...(parts.setup ? { setup: parts.setup } : {}),
    ...(parts.teardown ? { teardown: parts.teardown } : {}),
    context: parts.context,
    secret: null,
    stageForm: "id",
    async make(fixture): Promise<Made> {
      let record: DemoRecord;
      switch (fixture.object) {
        case "company":
          record = await raw.insert("company", fixture.name, {});
          break;
        case "contact": {
          const space = fixture.name.lastIndexOf(" ");
          record = await raw.insert("contact", fixture.name, {
            firstName: space < 0 ? fixture.name : fixture.name.slice(0, space),
            lastName: space < 0 ? null : fixture.name.slice(space + 1),
            title: fixture.title,
            email: fixture.email,
            phone: fixture.phone,
            ...(fixture.company ? { companyId: fixture.company.id } : {}),
          });
          break;
        }
        case "deal":
          record = await raw.insert("deal", fixture.name, {
            stage: fixture.stage.stageId,
            amount: fixture.amount,
            closeDate: fixture.closeDate,
            ...(fixture.company ? { companyId: fixture.company.id } : {}),
          });
          break;
      }
      return { ref: refOf(record.kind, record.id), seen: demoMirrorValues(record) };
    },
    async read(ref) {
      if (isRecordKind(ref.object)) {
        const record = await raw.read(ref.object, ref.id);
        return record === null ? null : rawRecord(record);
      }
      const activity = await raw.activity(ref.object, ref.id);
      return activity === null ? null : rawActivity(activity);
    },
    async find(object, marker) {
      if (isRecordKind(object)) return (await raw.withWriteId(object, marker)).map(rawRecord);
      return (await raw.activitiesWithWriteId(object, marker)).map(rawActivity);
    },
    async associations(ref) {
      if (isRecordKind(ref.object)) {
        const record = await raw.read(ref.object, ref.id);
        const company = record?.properties.companyId;
        return typeof company === "string" ? [refOf("company", company)] : [];
      }
      const activity = await raw.activity(ref.object, ref.id);
      return activity === null ? [] : [refOf(activity.record.kind, activity.record.id)];
    },
    async edit(ref, edit) {
      if (!isRecordKind(ref.object)) throw new Error("only a demo record can be edited");
      const record = await raw.update(ref.object, ref.id, {
        [EDIT_PROPERTY[edit.field]]: edit.value,
      });
      return demoMirrorValues(record);
    },
    async remove(ref) {
      if (!isRecordKind(ref.object)) throw new Error("only a demo record can be removed");
      await raw.remove(ref.object, ref.id);
    },
    refusedValue: { field: "email", value: "not an email" },
  };
}

/** Raw operations on a store in memory, for `demoHarness`. */
export function memoryDemoRaw(store: MemoryDemoStore): DemoRaw {
  return {
    insert: async (kind, name, properties) => store.seed(kind, name, properties),
    read: (kind, id) => store.record(kind, id),
    withWriteId: async (kind, writeId) => store.recordsWithWriteId(kind, writeId),
    activitiesWithWriteId: async (kind, writeId) =>
      store
        .activities()
        .filter((activity) => activity.kind === kind && activity.writeId === writeId),
    activity: async (kind, id) =>
      store.activities().find((activity) => activity.kind === kind && activity.id === id) ?? null,
    update: async (kind, id, properties) => store.touch(kind, id, properties),
    remove: async (kind, id) => store.remove(kind, id),
  };
}
