// The demo CRM as a CRM (Phase 6 spec WP2; docs/adr/0041): `provider: "demo"`, the demo dataset's
// stages, no owners, every write upserted by its marker (a record's `writeId` property, an activity's
// `write_id`), and its I/O through the demo's own API (./api.ts), served from a `DemoStore` in the
// caller's transaction. Records it makes are demo rows (`demo:added:…`) with their arrival in the
// mirror's history; notes, tasks, and meetings go in `crm_demo_activities`.
import type { CrmObject, ExternalRef, FieldValue } from "@earshot/core";
import type { CrmAdapter, CrmChange, CrmContext, PlannedWrite, WriteRef } from "../adapter";
import { CrmError, errorFromResponse, networkError } from "../errors";
import { buildPlan, type PlanColumn } from "../plan/table";
import { outcomeRef, previewOf, previewRef, type RequestSpec, requestOf } from "../render";
import { DEMO_MAX_BODY_CHARS, demoPath } from "./api";
import { DEMO_CAPABILITIES, DEMO_SCHEMA } from "./schema";
import type { DemoActivityKind, DemoRecordKind, DemoValue } from "./store";

/** How the demo CRM reads in a sentence: a refusal's words, an error's. */
const CRM_NAME = "the demo CRM";

/** The proposal's field a demo property holds, for an error that names one. */
const FIELD_OF: Readonly<Record<string, string>> = {
  name: "name",
  firstName: "name",
  lastName: "name",
  title: "title",
  email: "email",
  phone: "phone",
  stage: "stage",
  amount: "amount",
  closeDate: "closeDate",
  body: "body",
  dueAt: "dueDate",
  startsAt: "date",
};

function isRecord(object: CrmObject): object is DemoRecordKind {
  return object === "company" || object === "contact" || object === "deal";
}

/** Properties without the ones a write doesn't hold. */
function defined(
  values: Readonly<Record<string, DemoValue | undefined>>,
): Record<string, DemoValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, DemoValue] => entry[1] !== undefined),
  );
}

/**
 * The demo CRM's column of §4.3's table: its properties are the demo rows' own (`firstName`,
 * `stage` by its id), a record's `name` among them, and a record's marker as `writeId`. A task's or
 * a meeting's title leads its body, since an activity row has no title of its own.
 */
export const DEMO_COLUMN: PlanColumn = {
  crm: CRM_NAME,
  capabilities: DEMO_CAPABILITIES,
  properties(draft, marker) {
    switch (draft.object) {
      case "company":
        return { name: draft.values.name, writeId: marker };
      case "contact": {
        const { values } = draft;
        const details = { title: values.title, email: values.email, phone: values.phone };
        return draft.op === "update"
          ? defined(details)
          : defined({
              name: values.name,
              firstName: values.firstName,
              lastName: values.lastName,
              ...details,
              writeId: marker,
            });
      }
      case "deal": {
        const { values } = draft;
        const changes = {
          stage: values.stage?.stageId,
          amount: values.amount,
          closeDate: values.closeDate,
        };
        return draft.op === "update"
          ? defined(changes)
          : defined({ name: values.name, ...changes, writeId: marker });
      }
      case "note":
        return { body: draft.values.body };
      case "task":
        return { body: `${draft.values.title}\n\n${draft.values.body}`, dueAt: draft.values.dueAt };
      case "meeting":
        return {
          body: `${draft.values.title}\n\n${draft.values.body}`,
          startsAt: draft.values.startsAt,
        };
    }
  },
  checkField: (_object, field) => field,
  // A task's or a meeting's title (at most 4,000 characters) leads its body, within the row's cap.
  maxBodyChars: { note: DEMO_MAX_BODY_CHARS, task: 15_000, meeting: 15_000 },
};

/** A write's requests to the demo API, from the refs it points at. */
export function demoSpecs(
  write: PlannedWrite,
  refOf: (ref: WriteRef) => ExternalRef,
): RequestSpec[] {
  switch (write.op) {
    case "create": {
      const associations = write.associate.map((link) => {
        const to = refOf(link.to);
        return { to: { object: to.object, id: to.id }, type: link.type };
      });
      return [
        {
          method: "PUT",
          path: `/${demoPath(write.object as DemoRecordKind | DemoActivityKind)}?writeId=${write.marker}`,
          body: {
            properties: write.properties,
            ...(associations.length > 0 ? { associations } : {}),
          },
        },
      ];
    }
    case "update": {
      if (write.ref === null) throw new TypeError("an update names its record");
      const ref = refOf(write.ref);
      return [
        {
          method: "PATCH",
          path: `/${demoPath(ref.object as DemoRecordKind)}/${encodeURIComponent(ref.id)}`,
          body: { properties: write.properties },
        },
      ];
    }
    case "associate":
      throw new TypeError(
        "the demo CRM sets associations on create: a plan for it has no association writes",
      );
  }
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

async function send(spec: RequestSpec, ctx: CrmContext, kind: "read" | "write"): Promise<Answer> {
  let response: Response;
  try {
    response = await ctx.fetch(requestOf(spec, ctx), { kind });
  } catch (cause) {
    if (cause instanceof CrmError) throw cause;
    throw networkError(cause, { crm: CRM_NAME });
  }
  let body: unknown = null;
  try {
    const raw = await response.text();
    body = raw === "" ? null : JSON.parse(raw);
  } catch (cause) {
    throw networkError(cause, { crm: CRM_NAME });
  }
  return { status: response.status, headers: response.headers, body };
}

function ok(answer: Answer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

/** The `CrmError` for a demo API answer that wasn't a success. */
function errorOf(answer: Answer): CrmError {
  const error = ((answer.body as { error?: unknown } | null)?.error ?? {}) as {
    code?: unknown;
    property?: unknown;
    existing?: { object?: unknown; id?: unknown };
  };
  const existing =
    error.existing?.object === "contact" && typeof error.existing.id === "string"
      ? { object: "contact" as const, id: error.existing.id, url: null }
      : null;
  return errorFromResponse(
    answer.status,
    {
      code: typeof error.code === "string" ? error.code : null,
      field: typeof error.property === "string" ? (FIELD_OF[error.property] ?? null) : null,
      existing,
    },
    answer.headers,
    { crm: "The demo CRM" },
  );
}

/** A record's or activity's ref from the demo API's answer. */
function refFrom(body: unknown): ExternalRef {
  const item = body as { object?: unknown; id?: unknown } | null;
  const object = item?.object;
  const valid =
    object === "company" ||
    object === "contact" ||
    object === "deal" ||
    object === "note" ||
    object === "task" ||
    object === "meeting";
  if (!valid || typeof item?.id !== "string") {
    throw new CrmError("unknown", "The demo CRM answered without a record");
  }
  return { object, id: item.id, url: null };
}

function scalar(value: unknown): FieldValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

/** A demo record's values as the mirror holds them: its own properties, a stage by its id. */
function mirrorValues(
  kind: string,
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, FieldValue>> {
  switch (kind) {
    case "deal":
      return {
        stage: scalar(properties.stage),
        amount: scalar(properties.amount),
        closeDate: scalar(properties.closeDate),
      };
    case "contact":
      return {
        title: scalar(properties.title),
        email: scalar(properties.email),
        phone: scalar(properties.phone),
      };
    default:
      return {};
  }
}

/**
 * The demo CRM's adapter. `verify` and `schema` answer from what the demo CRM is, with no call;
 * everything else goes through the context's `fetch` to the demo API (`demoContext`).
 */
export const demoAdapter: CrmAdapter = {
  provider: "demo",
  capabilities: DEMO_CAPABILITIES,
  plan: (input) => buildPlan(input, DEMO_COLUMN),
  requests(plan, ctx) {
    return plan.writes.flatMap((write) =>
      demoSpecs(write, (ref) => previewRef(ref, plan)).map((spec) =>
        previewOf(spec, ctx, { credential: false }),
      ),
    );
  },
  async verify(ctx) {
    return {
      accountId: ctx.connection.accountId,
      accountName: "The demo CRM",
      actor: null,
      scopes: [],
    };
  },
  async schema() {
    return DEMO_SCHEMA;
  },
  async get(ref, fields, ctx) {
    if (!isRecord(ref.object)) return null;
    const answer = await send(
      { method: "GET", path: `/${demoPath(ref.object)}/${encodeURIComponent(ref.id)}` },
      ctx,
      "read",
    );
    if (answer.status === 404) return null;
    if (!ok(answer)) throw errorOf(answer);
    const record = answer.body as { name?: unknown; properties?: Record<string, unknown> };
    const values: Record<string, FieldValue> = {};
    for (const field of fields) {
      values[field] = field === "name" ? scalar(record.name) : scalar(record.properties?.[field]);
    }
    return { ref: refFrom(answer.body), values };
  },
  async reconcile(write, _done, ctx) {
    if (write.op !== "create") return null;
    const kind = write.object as DemoRecordKind | DemoActivityKind;
    const answer = await send(
      { method: "GET", path: `/${demoPath(kind)}?writeId=${write.marker}` },
      ctx,
      "read",
    );
    if (!ok(answer)) throw errorOf(answer);
    const [found] = ((answer.body as { results?: unknown[] } | null)?.results ?? []) as unknown[];
    return found === undefined ? null : { index: write.index, op: "found", ref: refFrom(found) };
  },
  async execute(write, done, ctx) {
    const [spec] = demoSpecs(write, (ref) => outcomeRef(ref, done));
    if (spec === undefined) throw new TypeError("a demo write has a request");
    const answer = await send(spec, ctx, "write");
    if (!ok(answer)) throw errorOf(answer);
    const op = write.op === "update" ? "updated" : answer.status === 201 ? "created" : "found";
    return { index: write.index, op, ref: refFrom(answer.body) };
  },
  async changes(cursor, ctx) {
    const after = cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`;
    const answer = await send({ method: "GET", path: `/changes?limit=100${after}` }, ctx, "read");
    if (!ok(answer)) throw errorOf(answer);
    const body = answer.body as {
      results: {
        object: string;
        id: string;
        name: string;
        properties: Record<string, unknown>;
        updatedAt: string;
      }[];
      next: string | null;
      more: boolean;
    };
    const changes: CrmChange[] = body.results.map((record) => ({
      ref: refFrom(record),
      kind: "changed",
      name: record.name,
      values: mirrorValues(record.object, record.properties),
      at: record.updatedAt,
    }));
    return { changes, cursor: body.next ?? cursor ?? "", more: body.more };
  },
};
