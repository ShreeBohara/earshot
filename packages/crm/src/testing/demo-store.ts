// The demo CRM's store in memory (Phase 6 WP2): `DemoStore` (../demo/store.ts) as `@earshot/db`'s
// `createDemoStore(tx)` keeps it over Postgres, for the demo adapter's tests here and anywhere a
// database is too much. It keeps the history a write leaves (`source: "sync"`, arrivals as a name
// from none) and a CRM user's own edits (`source: "demo"`), on a clock that moves 1 ms a write.
// Worker-safe.
import type {
  DemoActivity,
  DemoActivityKind,
  DemoCursor,
  DemoRecord,
  DemoRecordKind,
  DemoStore,
  DemoValue,
} from "../demo/store";

/** A change the store recorded, as `crm_entity_changes` would hold it. */
export interface DemoChangeRow {
  readonly kind: DemoRecordKind;
  readonly id: string;
  readonly field: string;
  readonly old: DemoValue;
  readonly new: DemoValue;
  readonly source: "demo" | "sync";
  readonly at: string;
}

interface Row {
  readonly kind: DemoRecordKind;
  readonly id: string;
  name: string;
  properties: Record<string, DemoValue>;
  updatedAt: string;
}

/** A demo CRM in memory: the store, and a CRM user's own hands on it (`seed`, `touch`, `remove`). */
export class MemoryDemoStore implements DemoStore {
  readonly #rows = new Map<string, Row>();
  readonly #activities: DemoActivity[] = [];
  readonly #tickMs: number;
  #clock: number;
  #ids = 0;
  /** Every change recorded, oldest first. */
  readonly history: DemoChangeRow[] = [];

  constructor(options: { readonly start?: string; readonly tickMs?: number } = {}) {
    this.#clock = Date.parse(options.start ?? "2026-11-25T12:00:00.000Z");
    this.#tickMs = options.tickMs ?? 1;
  }

  /** The clock, moved on by a tick: each write happens after the last. */
  #now(): string {
    this.#clock += this.#tickMs;
    return new Date(this.#clock).toISOString();
  }

  #view(row: Row): DemoRecord {
    return {
      kind: row.kind,
      id: row.id,
      name: row.name,
      properties: { ...row.properties },
      updatedAt: row.updatedAt,
    };
  }

  async record(kind: DemoRecordKind, id: string): Promise<DemoRecord | null> {
    const row = this.#rows.get(`${kind}:${id}`);
    return row ? this.#view(row) : null;
  }

  async recordByWriteId(kind: DemoRecordKind, writeId: string): Promise<DemoRecord | null> {
    return this.recordsWithWriteId(kind, writeId)[0] ?? null;
  }

  async contactByEmail(email: string): Promise<DemoRecord | null> {
    const wanted = email.toLowerCase();
    for (const row of this.#rows.values()) {
      const held = row.properties.email;
      if (row.kind === "contact" && typeof held === "string" && held.toLowerCase() === wanted)
        return this.#view(row);
    }
    return null;
  }

  async upsertRecord(record: {
    readonly kind: DemoRecordKind;
    readonly name: string;
    readonly properties: Readonly<Record<string, DemoValue>>;
    readonly writeId: string;
  }): Promise<{ readonly record: DemoRecord; readonly created: boolean }> {
    const existing = await this.recordByWriteId(record.kind, record.writeId);
    if (existing) return { record: existing, created: false };
    this.#ids += 1;
    const at = this.#now();
    const row: Row = {
      kind: record.kind,
      id: `added:00000000-0000-4000-8000-${String(this.#ids).padStart(12, "0")}`,
      name: record.name,
      properties: { ...record.properties, writeId: record.writeId },
      updatedAt: at,
    };
    this.#rows.set(`${row.kind}:${row.id}`, row);
    this.history.push({
      kind: row.kind,
      id: row.id,
      field: "name",
      old: null,
      new: row.name,
      source: "sync",
      at,
    });
    return { record: this.#view(row), created: true };
  }

  async updateRecord(
    kind: DemoRecordKind,
    id: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): Promise<DemoRecord | null> {
    const row = this.#rows.get(`${kind}:${id}`);
    return row ? this.#change(row, properties, "sync") : null;
  }

  #change(
    row: Row,
    properties: Readonly<Record<string, DemoValue>>,
    source: "demo" | "sync",
  ): DemoRecord {
    const at = this.#now();
    let changed = false;
    for (const [field, value] of Object.entries(properties)) {
      const old = field === "name" ? row.name : (row.properties[field] ?? null);
      if (old === value) continue;
      changed = true;
      if (field === "name") row.name = String(value);
      else row.properties[field] = value;
      this.history.push({ kind: row.kind, id: row.id, field, old, new: value, source, at });
    }
    if (changed) row.updatedAt = at;
    return this.#view(row);
  }

  async activityByWriteId(kind: DemoActivityKind, writeId: string): Promise<DemoActivity | null> {
    return (
      this.#activities.find((activity) => activity.kind === kind && activity.writeId === writeId) ??
      null
    );
  }

  async upsertActivity(activity: {
    readonly kind: DemoActivityKind;
    readonly record: { readonly kind: DemoRecordKind; readonly id: string };
    readonly writeId: string;
    readonly body: string;
    readonly dueAt: string | null;
    readonly startsAt: string | null;
  }): Promise<{ readonly activity: DemoActivity; readonly created: boolean } | null> {
    // The write id is unique in the workspace, whatever the kind.
    const existing = this.#activities.find((candidate) => candidate.writeId === activity.writeId);
    if (existing) return { activity: existing, created: false };
    if (!this.#rows.has(`${activity.record.kind}:${activity.record.id}`)) return null;
    this.#ids += 1;
    const made: DemoActivity = {
      ...activity,
      id: `00000000-0000-4000-8000-${String(this.#ids).padStart(12, "0")}`,
      createdAt: this.#now(),
    };
    this.#activities.push(made);
    return { activity: made, created: true };
  }

  async changes(after: DemoCursor | null, limit: number): Promise<DemoRecord[]> {
    const key = (row: { updatedAt: string; id: string }) => `${row.updatedAt}\u0000${row.id}`;
    const from = after === null ? null : key({ updatedAt: after.at, id: after.id });
    return [...this.#rows.values()]
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .filter((row) => from === null || key(row) > from)
      .slice(0, limit)
      .map((row) => this.#view(row));
  }

  // ── A CRM user's own hands, for the harness ──

  /** Makes a record as the dataset's are made: a demo row, with no history. */
  seed(
    kind: DemoRecordKind,
    name: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): DemoRecord {
    this.#ids += 1;
    const prefix = kind === "company" ? "co" : kind === "contact" ? "ct" : "deal";
    const row: Row = {
      kind,
      id: `${prefix}_t${String(this.#ids).padStart(4, "0")}`,
      name,
      properties: { ...properties },
      updatedAt: this.#now(),
    };
    this.#rows.set(`${kind}:${row.id}`, row);
    return this.#view(row);
  }

  /** A CRM user's edit ("Simulate a CRM change"), recorded as the demo controls record theirs. */
  touch(
    kind: DemoRecordKind,
    id: string,
    properties: Readonly<Record<string, DemoValue>>,
  ): DemoRecord {
    const row = this.#rows.get(`${kind}:${id}`);
    if (!row) throw new Error(`the demo CRM has no ${kind} ${id}`);
    return this.#change(row, properties, "demo");
  }

  /** Deletes a record, with its activities, as removing a demo row does. */
  remove(kind: DemoRecordKind, id: string): void {
    this.#rows.delete(`${kind}:${id}`);
    for (let index = this.#activities.length - 1; index >= 0; index -= 1) {
      const activity = this.#activities[index] as DemoActivity;
      if (activity.record.kind === kind && activity.record.id === id)
        this.#activities.splice(index, 1);
    }
  }

  /** Every record of a kind holding this marker: more than one would be a duplicate. */
  recordsWithWriteId(kind: DemoRecordKind, writeId: string): DemoRecord[] {
    return [...this.#rows.values()]
      .filter((row) => row.kind === kind && row.properties.writeId === writeId)
      .map((row) => this.#view(row));
  }

  /** Every activity, oldest first. */
  activities(): readonly DemoActivity[] {
    return [...this.#activities];
  }
}
