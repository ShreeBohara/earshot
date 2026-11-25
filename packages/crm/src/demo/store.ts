// What the demo adapter writes through (Phase 6 spec §4.2, §4.4, WP2; docs/adr/0041): the demo CRM's
// records and activities, as a store the adapter defines and `@earshot/db` implements over a
// workspace's demo rows (`createDemoStore(tx)`), in the caller's transaction: properties on demo
// records with a history row (`source: "sync"`) for each field a write changes, an arrival for each
// record a write makes, and notes, tasks, and meetings in `crm_demo_activities`. `@earshot/crm/testing`
// has one in memory. Only the workspace's demo rows: no connection, the `demo:` prefix.

/** The demo CRM's records: the kinds `crm_entities` holds. */
export type DemoRecordKind = "company" | "contact" | "deal";
/** The demo CRM's activities: the kinds `crm_demo_activities` holds. */
export type DemoActivityKind = "note" | "task" | "meeting";
/** A property's value on a demo record: a JSON scalar, or none. */
export type DemoValue = string | number | boolean | null;

/** A demo record, as the store reads it. */
export interface DemoRecord {
  readonly kind: DemoRecordKind;
  /**
   * Its id in the demo CRM, which `ExternalRef.id` carries: its mirror row's external id without the
   * `demo:` prefix, so the dataset's own (`co_001`) or an added record's (`added:…`).
   */
  readonly id: string;
  readonly name: string;
  /** Its properties, a write's `writeId` among them, without its name. */
  readonly properties: Readonly<Record<string, DemoValue>>;
  /** When it last changed, as an ISO time. */
  readonly updatedAt: string;
}

/** A note, task, or meeting on a demo record. */
export interface DemoActivity {
  readonly kind: DemoActivityKind;
  readonly id: string;
  /** The demo record it's on. */
  readonly record: { readonly kind: DemoRecordKind; readonly id: string };
  /** The marker of the write that made it: unique in its workspace. */
  readonly writeId: string;
  readonly body: string;
  readonly dueAt: string | null;
  readonly startsAt: string | null;
  readonly createdAt: string;
}

/** Where a page of changes starts after: the last record's change time and id. */
export interface DemoCursor {
  readonly at: string;
  readonly id: string;
}

/** A workspace's demo CRM, in the caller's transaction. */
export interface DemoStore {
  /** A demo record, by its kind and id; null when the workspace has no such demo record. */
  record(kind: DemoRecordKind, id: string): Promise<DemoRecord | null>;
  /** The demo record of this kind a write made, by its marker; null when none did. */
  recordByWriteId(kind: DemoRecordKind, writeId: string): Promise<DemoRecord | null>;
  /** A demo contact holding this email, whatever its case; null when none does. */
  contactByEmail(email: string): Promise<DemoRecord | null>;
  /**
   * Makes a demo record (`demo:added:…`) whose properties hold `writeId`, with its arrival in the
   * history (its name, from none); or, when a record of the kind already holds that `writeId`,
   * finds it and changes nothing (`created: false`). One or the other, never both, even when two
   * writers try at once.
   */
  upsertRecord(record: {
    readonly kind: DemoRecordKind;
    readonly name: string;
    readonly properties: Readonly<Record<string, DemoValue>>;
    readonly writeId: string;
  }): Promise<{ readonly record: DemoRecord; readonly created: boolean }>;
  /**
   * Sets properties on a demo record (`name` sets its name), with a history row for each field whose
   * value changes; null when there's no such demo record.
   */
  updateRecord(
    kind: DemoRecordKind,
    id: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): Promise<DemoRecord | null>;
  /** The activity of this kind a write made, by its marker; null when none did. */
  activityByWriteId(kind: DemoActivityKind, writeId: string): Promise<DemoActivity | null>;
  /**
   * Makes an activity on a demo record, or finds the one its `writeId` already made (`created:
   * false`); null when the record isn't one of the workspace's demo records.
   */
  upsertActivity(activity: {
    readonly kind: DemoActivityKind;
    readonly record: { readonly kind: DemoRecordKind; readonly id: string };
    readonly writeId: string;
    readonly body: string;
    readonly dueAt: string | null;
    readonly startsAt: string | null;
  }): Promise<{ readonly activity: DemoActivity; readonly created: boolean } | null>;
  /**
   * Demo records changed after a cursor, by their change time and then id, at most `limit`. Like any
   * poll by change time, a record changed at the cursor's instant after it was read can be missed:
   * nothing polls the demo CRM in production, since its rows are the mirror itself.
   */
  changes(after: DemoCursor | null, limit: number): Promise<DemoRecord[]>;
}
