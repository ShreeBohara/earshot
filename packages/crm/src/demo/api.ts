// The demo CRM's API (Phase 6 spec WP2; docs/adr/0041): a small REST API under `demo:`, served from a
// `DemoStore` in the caller's transaction and never over a network, so the demo adapter does its I/O
// through `CrmContext.fetch` like every other adapter: what its dry run previews is what it sends,
// and the conformance suite can drop an answer or read every request the same way. The outbox (WP3)
// builds the demo's context with `demoContext(createDemoStore(tx))`; `ConnectionDO` never sees it.
//
// | Request | Does |
// |---|---|
// | `GET demo:/{companies,contacts,deals}/{id}` | a record; 404 when it isn't one of the workspace's demo records |
// | `GET demo:/{kind}s?writeId=` | the record or activity a write made, as a list |
// | `PUT demo:/{companies,contacts,deals}?writeId=` | makes a record (201), or finds the one its marker made (200) |
// | `PATCH demo:/{companies,contacts,deals}/{id}` | sets properties |
// | `PUT demo:/{notes,tasks,meetings}?writeId=` | makes an activity on the record it's associated with (201), or finds it (200) |
// | `GET demo:/changes?after=&limit=` | records changed after a cursor, a page at a time |
//
// Errors are `{ "error": { "code", "property"?, "existing"? } }`, as MemoryCrm's: 400 `invalid_value`
// naming the property, 404 `not_found`, 409 `duplicate` (a contact's email, with the contact that
// has it).
import { containsKeyShape } from "@earshot/core";
import type { CrmContext } from "../adapter";
import { isCalendarDay } from "../plan/time";
import { DEMO_STAGES } from "./schema";
import type {
  DemoActivity,
  DemoActivityKind,
  DemoCursor,
  DemoRecord,
  DemoRecordKind,
  DemoStore,
  DemoValue,
} from "./store";

/** Where the demo CRM's API lives: a scheme of its own, which nothing but its handler answers. */
export const DEMO_API_BASE = "demo:";

/** The most a page of changes holds, and the most a request may ask for. */
export const DEMO_MAX_PAGE = 100;

/** The longest activity body the demo CRM keeps (`crm_demo_activities`' check). */
export const DEMO_MAX_BODY_CHARS = 20_000;

/** The longest name, as the session socket caps an entity's name. */
const MAX_NAME_CHARS = 200;
const MAX_TEXT_CHARS = 200;
const MARKER = /^es_[a-z2-7]{20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const RECORD_PATHS: Readonly<Record<string, DemoRecordKind>> = {
  companies: "company",
  contacts: "contact",
  deals: "deal",
};
const ACTIVITY_PATHS: Readonly<Record<string, DemoActivityKind>> = {
  notes: "note",
  tasks: "task",
  meetings: "meeting",
};

/** A kind's path in the API: `company` is `companies`. */
export function demoPath(kind: DemoRecordKind | DemoActivityKind): string {
  return kind === "company" ? "companies" : `${kind}s`;
}

type Check = (value: DemoValue) => boolean;

const text: Check = (value) => typeof value === "string" && value.length <= MAX_TEXT_CHARS;
const nullableText: Check = (value) => value === null || text(value);
/** A record's name: some words, at most 200 characters, nothing shaped like a key. */
const name: Check = (value) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= MAX_NAME_CHARS &&
  !containsKeyShape(value);

/** The properties each kind of record takes, and how each is checked. */
const RECORD_PROPERTIES: Readonly<Record<DemoRecordKind, Readonly<Record<string, Check>>>> = {
  company: { name },
  contact: {
    name,
    firstName: nullableText,
    lastName: nullableText,
    title: nullableText,
    email: (value) =>
      value === null || (typeof value === "string" && value.length <= 254 && EMAIL.test(value)),
    phone: (value) => value === null || (typeof value === "string" && value.length <= 40),
  },
  deal: {
    name,
    stage: (value) => DEMO_STAGES.some((stage) => stage.stageId === value),
    amount: (value) =>
      value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0),
    closeDate: (value) => value === null || isCalendarDay(value),
  },
};

/** An ISO instant, or none. */
const instant: Check = (value) =>
  value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));

const ACTIVITY_PROPERTIES: Readonly<Record<DemoActivityKind, Readonly<Record<string, Check>>>> = {
  note: {},
  task: { dueAt: instant },
  meeting: { startsAt: instant },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, ...extra } });
}

function recordJson(record: DemoRecord) {
  return {
    object: record.kind,
    id: record.id,
    name: record.name,
    properties: record.properties,
    updatedAt: record.updatedAt,
  };
}

function activityJson(activity: DemoActivity) {
  return {
    object: activity.kind,
    id: activity.id,
    record: { object: activity.record.kind, id: activity.record.id },
    writeId: activity.writeId,
    body: activity.body,
    dueAt: activity.dueAt,
    startsAt: activity.startsAt,
    createdAt: activity.createdAt,
  };
}

/** A request's JSON body as an object; `{}` for none or anything else. */
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Properties as the demo CRM takes them: scalars only. */
function propertiesOf(body: Record<string, unknown>): Record<string, DemoValue> | null {
  const properties = body.properties ?? {};
  if (typeof properties !== "object" || properties === null || Array.isArray(properties))
    return null;
  const out: Record<string, DemoValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** The first property a check refuses (or doesn't know), or null. */
function refused(
  properties: Readonly<Record<string, DemoValue>>,
  checks: Readonly<Record<string, Check>>,
): string | null {
  for (const [key, value] of Object.entries(properties)) {
    const check = checks[key];
    if (check === undefined || !check(value)) return key;
  }
  return null;
}

/** The one record an activity is associated with, or null when the body doesn't name one. */
function recordLink(body: Record<string, unknown>): { kind: DemoRecordKind; id: string } | null {
  const links = body.associations;
  if (!Array.isArray(links) || links.length !== 1) return null;
  const to = (links[0] as { to?: { object?: unknown; id?: unknown } } | undefined)?.to;
  const kind = to?.object;
  if ((kind !== "company" && kind !== "contact" && kind !== "deal") || typeof to?.id !== "string")
    return null;
  return { kind, id: to.id };
}

/** A new person's or deal's company, as its `companyId`; undefined for none, null for one that isn't there. */
async function companyOf(
  store: DemoStore,
  body: Record<string, unknown>,
): Promise<string | null | undefined> {
  const links = body.associations;
  if (links === undefined) return undefined;
  const link = recordLink(body);
  if (link === null || link.kind !== "company") return null;
  return (await store.record("company", link.id)) === null ? null : link.id;
}

function cursorOf(text: string | null): DemoCursor | null | undefined {
  if (text === null || text === "") return null;
  const at = text.lastIndexOf("~");
  if (at <= 0) return undefined;
  return { at: text.slice(0, at), id: text.slice(at + 1) };
}

/** Options for the demo CRM's API: how many changes a page holds (100 by default). */
export interface DemoApiOptions {
  readonly pageSize?: number;
}

/** The demo CRM's API over a store: a `fetch` handler for `demo:` requests, which never touches a network. */
export function demoFetch(
  store: DemoStore,
  options: DemoApiOptions = {},
): (request: Request) => Promise<Response> {
  const pageSize = Math.min(options.pageSize ?? DEMO_MAX_PAGE, DEMO_MAX_PAGE);
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== DEMO_API_BASE) return fail(404, "not_found");
    const [path, rawId, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (rest.length > 0 || path === undefined) return fail(404, "not_found");
    const writeId = url.searchParams.get("writeId");
    const method = request.method;

    if (path === "changes" && method === "GET") {
      const after = cursorOf(url.searchParams.get("after"));
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? DEMO_MAX_PAGE : Number(limitText);
      if (after === undefined || !Number.isInteger(limit) || limit < 1 || limit > DEMO_MAX_PAGE) {
        return fail(400, "invalid_value", { property: after === undefined ? "after" : "limit" });
      }
      const size = Math.min(limit, pageSize);
      const page = await store.changes(after, size + 1);
      const shown = page.slice(0, size);
      const last = shown.at(-1);
      return json(200, {
        results: shown.map(recordJson),
        next:
          last === undefined
            ? (url.searchParams.get("after") ?? null)
            : `${last.updatedAt}~${last.id}`,
        more: page.length > size,
      });
    }

    const recordKind = RECORD_PATHS[path];
    if (recordKind !== undefined) {
      if (rawId !== undefined) {
        const record = await store.record(recordKind, rawId);
        if (record === null) return fail(404, "not_found");
        if (method === "GET") return json(200, recordJson(record));
        if (method !== "PATCH") return fail(405, "method_not_allowed");
        const properties = propertiesOf(await bodyOf(request));
        if (properties === null) return fail(400, "invalid_value", { property: "properties" });
        const bad = refused(properties, RECORD_PROPERTIES[recordKind]);
        if (bad !== null) return fail(400, "invalid_value", { property: bad });
        if (recordKind === "contact" && typeof properties.email === "string") {
          const holder = await store.contactByEmail(properties.email);
          if (holder !== null && holder.id !== record.id) {
            return fail(409, "duplicate", {
              property: "email",
              existing: { object: "contact", id: holder.id },
            });
          }
        }
        const updated = await store.updateRecord(recordKind, record.id, properties);
        return updated === null ? fail(404, "not_found") : json(200, recordJson(updated));
      }
      if (writeId === null || !MARKER.test(writeId)) {
        return fail(400, "invalid_value", { property: "writeId" });
      }
      if (method === "GET") {
        const record = await store.recordByWriteId(recordKind, writeId);
        return json(200, { results: record === null ? [] : [recordJson(record)] });
      }
      if (method !== "PUT") return fail(405, "method_not_allowed");
      const body = await bodyOf(request);
      const properties = propertiesOf(body);
      if (properties === null) return fail(400, "invalid_value", { property: "properties" });
      const { name: recordName, writeId: stated, ...rest } = properties;
      if (stated !== undefined && stated !== writeId)
        return fail(400, "invalid_value", { property: "writeId" });
      const bad = refused({ name: recordName ?? null, ...rest }, RECORD_PROPERTIES[recordKind]);
      if (bad !== null) return fail(400, "invalid_value", { property: bad });
      const already = await store.recordByWriteId(recordKind, writeId);
      if (already !== null) return json(200, recordJson(already));
      const company = recordKind === "company" ? undefined : await companyOf(store, body);
      if (company === null) return fail(400, "invalid_value", { property: "associations" });
      if (recordKind === "contact" && typeof rest.email === "string") {
        const holder = await store.contactByEmail(rest.email);
        if (holder !== null && holder.properties.writeId !== writeId) {
          return fail(409, "duplicate", {
            property: "email",
            existing: { object: "contact", id: holder.id },
          });
        }
      }
      const { record, created } = await store.upsertRecord({
        kind: recordKind,
        name: String(recordName).replace(/\s+/g, " ").trim(),
        properties: { ...rest, ...(company === undefined ? {} : { companyId: company }), writeId },
        writeId,
      });
      return json(created ? 201 : 200, recordJson(record));
    }

    const activityKind = ACTIVITY_PATHS[path];
    if (activityKind !== undefined && rawId === undefined) {
      if (writeId === null || !MARKER.test(writeId)) {
        return fail(400, "invalid_value", { property: "writeId" });
      }
      if (method === "GET") {
        const activity = await store.activityByWriteId(activityKind, writeId);
        return json(200, { results: activity === null ? [] : [activityJson(activity)] });
      }
      if (method !== "PUT") return fail(405, "method_not_allowed");
      const body = await bodyOf(request);
      const properties = propertiesOf(body);
      if (properties === null) return fail(400, "invalid_value", { property: "properties" });
      const { body: textBody, ...times } = properties;
      if (
        typeof textBody !== "string" ||
        textBody === "" ||
        textBody.length > DEMO_MAX_BODY_CHARS
      ) {
        return fail(400, "invalid_value", { property: "body" });
      }
      const bad = refused(times, ACTIVITY_PROPERTIES[activityKind]);
      if (bad !== null) return fail(400, "invalid_value", { property: bad });
      const link = recordLink(body);
      if (link === null) return fail(400, "invalid_value", { property: "associations" });
      const made = await store.upsertActivity({
        kind: activityKind,
        record: link,
        writeId,
        body: textBody,
        dueAt: typeof times.dueAt === "string" ? new Date(times.dueAt).toISOString() : null,
        startsAt:
          typeof times.startsAt === "string" ? new Date(times.startsAt).toISOString() : null,
      });
      if (made === null) return fail(404, "not_found");
      return json(made.created ? 201 : 200, activityJson(made.activity));
    }
    return fail(404, "not_found");
  };
}

/**
 * The demo CRM's context: no connection (`id: null`), the workspace as its account, and a `fetch`
 * served by `demoFetch` from the store. No credential: the demo CRM takes none.
 */
export function demoContext(
  store: DemoStore,
  options: DemoApiOptions & { readonly accountId?: string } = {},
): CrmContext {
  const handle = demoFetch(store, options);
  return {
    connection: { id: null, accountId: options.accountId ?? "demo", apiBase: DEMO_API_BASE },
    fetch: (request) => handle(request),
  };
}
