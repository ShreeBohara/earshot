// The reference CRM (Phase 6 spec §4.2; docs/adr/0041): a CRM in memory, behind a small REST API of
// its own, with an adapter that speaks that API only through `CrmContext.fetch`, as every real
// adapter must. Every capability is configurable: each idempotency mode for records and activities
// (`upsert`, `client_id`, `readback`), associations inline or separate, owners on or off, meetings
// on or off, deletes reported or not. It injects faults by seed at three points (./faults.ts),
// lags its search, and answers 429 with `Retry-After` past a rate limit. The conformance suite's
// own tests and the outbox's tests (WP3) run on it, and its harness lets the suite make fixtures,
// read records back raw, and edit or delete them behind Earshot's back. Worker-safe: no Node APIs.
//
// Its API, under `https://memory-crm.test`, with `Authorization: Bearer <token>`:
//
// | Request | Does |
// |---|---|
// | `GET /v1/account` | the account, the key's user, and its scopes |
// | `GET /v1/schema` | stages, owners, association types, and the marker property |
// | `GET /v1/objects/{object}/{id}` | a record, its stage's label, and its associations; 404 when gone |
// | `GET /v1/objects/{object}?property=&equals=` or `&contains=` | a filtered list: consistent at once |
// | `GET /v1/search?object=&q=` | search, which sees a record only `searchLagMs` after it's made |
// | `POST /v1/objects/{object}` | a create, with a client's `id` in `client_id` mode, `associations` when inline |
// | `PUT /v1/objects/{object}?upsertBy=earshot_write_id` | an upsert by the marker, in `upsert` mode: 201 made, 200 found |
// | `PATCH /v1/objects/{object}/{id}` | an update of the properties given |
// | `PUT /v1/associations` | an association, made once however often it's sent |
// | `GET /v1/changes?after=&limit=` | records changed since a cursor, oldest first, a page at a time |
//
// Errors are `{ "error": { "code", "property"?, "existing"? } }`: 400 `invalid_value` naming the
// property, 401 `unauthorized`, 404 `not_found`, 409 `id_taken` (a client id) or `duplicate` (a
// contact's email, with the record that has it), 429 `rate_limited`.
import type { CrmObject, CrmProvider, ExternalRef, FieldValue } from "@earshot/core";
import type {
  Capabilities,
  ChangePage,
  ConnectionInfo,
  CrmAdapter,
  CrmChange,
  CrmContext,
  CrmRecord,
  CrmSchema,
  CrmStage,
  CrmValue,
  IdempotencyMode,
  PlanInput,
  PlannedWrite,
  PlanResult,
  RenderContext,
  RequestPreview,
  WriteOutcome,
  WritePlan,
  WriteRef,
} from "../adapter";
import { CrmError, errorFromResponse, networkError } from "../errors";
import { markerUuid } from "../markers";
import { hasActivityLine } from "../plan/line";
import { buildPlan, type CheckedField, type PlanColumn } from "../plan/table";
import { outcomeRef, previewOf, previewRef, type RequestSpec, requestOf } from "../render";
import { type FaultPlan, type FaultPoint, faultSchedule } from "./faults";
import type {
  ConformanceHarness,
  Fixture,
  FixtureEdit,
  HarnessAnswer,
  Made,
  MirrorValues,
  RawRecord,
} from "./harness";

/** Where MemoryCrm's API lives. Nothing resolves it: only MemoryCrm's own `fetch` answers it. */
export const MEMORY_CRM_API = "https://memory-crm.test";

/** The property records (and activities, outside `readback`) keep their write's marker in. */
export const MEMORY_MARKER_PROPERTY = "earshot_write_id";

/** The deal stages MemoryCrm has unless told otherwise: one pipeline, `sales`. */
export const MEMORY_STAGES: readonly CrmStage[] = [
  { stageId: "st_discovery", pipelineId: "sales", label: "Discovery" },
  { stageId: "st_proposal", pipelineId: "sales", label: "Proposal" },
  { stageId: "st_negotiation", pipelineId: "sales", label: "Negotiation" },
  { stageId: "st_won", pipelineId: "sales", label: "Closed won" },
  { stageId: "st_lost", pipelineId: "sales", label: "Closed lost" },
];

/** The CRM user tasks are assigned to, when owners are on. */
export const MEMORY_OWNER = { ownerId: "ow_rep", email: "rep@memory-crm.test", name: "Riley Rep" };

export interface MemoryCrmOptions {
  /** Which real CRM it stands in for, in sync events; Twenty, the reference, by default. */
  readonly provider?: Exclude<CrmProvider, "demo">;
  /** How it keeps a write to one, for records and activities; `upsert` for both by default. */
  readonly idempotency?: {
    readonly records?: IdempotencyMode;
    readonly activities?: IdempotencyMode;
  };
  /** Associations set on create (default), or by calls of their own. */
  readonly associations?: "inline" | "separate";
  /** Whether tasks can be assigned (default true). */
  readonly owners?: boolean;
  /** Whether it has meetings (default true). */
  readonly meetings?: boolean;
  /** Whether `changes` reports deleted records (default true). */
  readonly deletes?: boolean;
  /** How many changes a page holds, whatever a request asks for (default 50). */
  readonly pageSize?: number;
  /** The most a request may ask for, its documented page size (default 100): more is a 400. */
  readonly maxPageSize?: number;
  /** How long a new record stays out of search (default 30 s), on MemoryCrm's clock. */
  readonly searchLagMs?: number;
  /** At most `limit` requests in each window of `windowMs` on its clock; past it, 429. */
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | null;
  /** Faults by seed at three points (./faults.ts). */
  readonly faults?: FaultPlan | null;
  /** The credential it takes. */
  readonly token?: string;
  readonly stages?: readonly CrmStage[];
  /** Where its clock starts; it moves only when `advance` moves it. */
  readonly start?: string;
}

/** A record as MemoryCrm stores it. */
interface Stored {
  readonly object: CrmObject;
  readonly id: string;
  properties: Record<string, CrmValue>;
  associations: {
    readonly object: CrmObject;
    readonly id: string;
    readonly type: string | number;
  }[];
  readonly createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
  /** Where its latest change falls among all of MemoryCrm's changes: what `changes` orders by. */
  changed: number;
}

/** An answer the next request gets, instead of what it would have. */
export type MemoryInjection =
  | FaultPoint
  | HarnessAnswer
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: CrmValue;
    };

const RECORDS: ReadonlySet<CrmObject> = new Set<CrmObject>(["company", "contact", "deal"]);
const ACTIVITIES: ReadonlySet<CrmObject> = new Set<CrmObject>(["note", "task", "meeting"]);
const ID_PREFIX: Readonly<Record<CrmObject, string>> = {
  company: "co",
  contact: "ct",
  deal: "dl",
  note: "nt",
  task: "tk",
  meeting: "mt",
};

type PropertyKind =
  | "text"
  | "email"
  | "money"
  | "day"
  | "instant"
  | "stage"
  | "owner"
  | "marker"
  | "body";

/** Each object's properties, and the ones a create must have. */
const PROPERTIES: Readonly<Record<CrmObject, Readonly<Record<string, PropertyKind>>>> = {
  company: { name: "text", earshot_write_id: "marker" },
  contact: {
    firstname: "text",
    lastname: "text",
    jobtitle: "text",
    email: "email",
    phone: "text",
    earshot_write_id: "marker",
  },
  deal: {
    dealname: "text",
    pipeline: "text",
    dealstage: "stage",
    amount: "money",
    closedate: "day",
    earshot_write_id: "marker",
  },
  note: { body: "body", timestamp: "instant", earshot_write_id: "marker" },
  task: {
    subject: "text",
    body: "body",
    due: "instant",
    status: "text",
    owner: "owner",
    earshot_write_id: "marker",
  },
  meeting: { title: "text", body: "body", start: "instant", earshot_write_id: "marker" },
};
const REQUIRED: Readonly<Record<CrmObject, readonly string[]>> = {
  company: ["name"],
  contact: ["firstname"],
  deal: ["dealname", "dealstage"],
  note: ["body"],
  task: ["subject"],
  meeting: ["title"],
};

/** The proposal's field a property holds, for an error that names one. */
const FIELD_OF: Readonly<Record<string, string>> = {
  firstname: "name",
  lastname: "name",
  jobtitle: "title",
  email: "email",
  phone: "phone",
  dealstage: "stage",
  amount: "amount",
  closedate: "closeDate",
  dealname: "target",
  name: "target",
  subject: "title",
  title: "title",
  body: "body",
  due: "dueDate",
  start: "date",
};

/** A deal's or a contact's checked field, by MemoryCrm's property for it. */
const CHECK_PROPERTY: Readonly<Record<CheckedField, string>> = {
  stage: "dealstage",
  amount: "amount",
  closeDate: "closedate",
  title: "jobtitle",
  email: "email",
  phone: "phone",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MARKER = /^es_[a-z2-7]{20}$/;

/** A JSON answer. */
function json(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, ...extra } });
}

function isFaultPoint(injection: MemoryInjection): injection is FaultPoint {
  return injection === "before" || injection === "after_commit" || injection === "after_response";
}

function isRecordObject(object: CrmObject): boolean {
  return RECORDS.has(object);
}

function asObject(text: string | undefined): CrmObject | null {
  return text !== undefined && (RECORDS.has(text as CrmObject) || ACTIVITIES.has(text as CrmObject))
    ? (text as CrmObject)
    : null;
}

/** A link to a record in MemoryCrm's app: a real https URL, as `ExternalRef.url` takes. */
function appUrl(object: CrmObject, id: string): string {
  return `${MEMORY_CRM_API}/app/${object}/${encodeURIComponent(id)}`;
}

/** The capabilities a set of options gives. */
export function memoryCapabilities(options: MemoryCrmOptions = {}): Capabilities {
  return {
    objects: {
      company: true,
      contact: true,
      deal: true,
      note: true,
      task: true,
      meeting: options.meetings ?? true,
    },
    idempotency: {
      records: options.idempotency?.records ?? "upsert",
      activities: options.idempotency?.activities ?? "upsert",
    },
    associations: options.associations ?? "inline",
    changes: "modified_since",
    webhooks: false,
    owners: options.owners ?? true,
    attribution: "key",
  };
}

// ─── The CRM ─────────────────────────────────────────────────────────────────────────────────

/** A record as MemoryCrm's API answers it. */
interface RecordJson {
  readonly object: CrmObject;
  readonly id: string;
  readonly url: string;
  readonly properties: Readonly<Record<string, CrmValue>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly associations: readonly {
    readonly object: CrmObject;
    readonly id: string;
    readonly type: string | number;
  }[];
  readonly modifiedAt: string;
}

/**
 * The reference CRM: its state and API (`handle`), contexts to call it through (`context`), its
 * adapter (it implements `CrmAdapter` through an adapter that only uses `ctx.fetch`), and its
 * harness for the conformance suite (`harness`).
 */
export class MemoryCrm implements CrmAdapter {
  readonly provider: Exclude<CrmProvider, "demo">;
  readonly capabilities: Capabilities;
  /** The credential it takes. */
  readonly token: string;
  readonly #options: MemoryCrmOptions;
  readonly #stages: readonly CrmStage[];
  readonly #records = new Map<string, Stored>();
  readonly #injections: MemoryInjection[] = [];
  readonly #fault: ((method: string) => FaultPoint | null) | null;
  readonly #adapter: CrmAdapter;
  #clock: number;
  #ids = 0;
  #changeCount = 0;
  #window = { start: 0, count: 0 };
  /** Every request it answered or failed, with how it counted and any fault it met. */
  readonly calls: {
    method: string;
    path: string;
    cost: string | null;
    fault: FaultPoint | null;
  }[] = [];

  constructor(options: MemoryCrmOptions = {}) {
    this.#options = options;
    this.provider = options.provider ?? "twenty";
    this.capabilities = memoryCapabilities(options);
    this.token = options.token ?? "mem_tok_7f3a9c1e5b2d4086a1f0";
    this.#stages = options.stages ?? MEMORY_STAGES;
    this.#fault = options.faults ? faultSchedule(options.faults) : null;
    this.#clock = Date.parse(options.start ?? "2026-11-25T12:00:00.000Z");
    this.#window.start = this.#clock;
    this.#adapter = memoryCrmAdapter({ provider: this.provider, capabilities: this.capabilities });
  }

  // ── The adapter, which reaches this CRM only through the context's fetch ──

  plan(input: PlanInput): PlanResult {
    return this.#adapter.plan(input);
  }
  requests(plan: WritePlan, ctx: RenderContext): RequestPreview[] {
    return this.#adapter.requests(plan, ctx);
  }
  verify(ctx: CrmContext): Promise<ConnectionInfo> {
    return this.#adapter.verify(ctx);
  }
  schema(ctx: CrmContext): Promise<CrmSchema> {
    return this.#adapter.schema(ctx);
  }
  get(ref: ExternalRef, fields: readonly string[], ctx: CrmContext): Promise<CrmRecord | null> {
    return this.#adapter.get(ref, fields, ctx);
  }
  reconcile(write: PlannedWrite, done: readonly WriteOutcome[], ctx: CrmContext) {
    return this.#adapter.reconcile(write, done, ctx);
  }
  execute(write: PlannedWrite, done: readonly WriteOutcome[], ctx: CrmContext) {
    return this.#adapter.execute(write, done, ctx);
  }
  changes(cursor: string | null, ctx: CrmContext): Promise<ChangePage> {
    return this.#adapter.changes(cursor, ctx);
  }

  // ── The clock, injections, and state ──

  /** Its clock, in ms; it moves only when `advance` moves it. */
  now(): number {
    return this.#clock;
  }

  advance(ms: number): void {
    this.#clock += ms;
  }

  /** Makes the next request's answer this one: a fault, a canned status, or a careless error. */
  inject(injection: MemoryInjection): void {
    this.#injections.push(injection);
  }

  /** Every live (not deleted) record of a kind, or of every kind. */
  records(object?: CrmObject): readonly Readonly<Stored>[] {
    return [...this.#records.values()].filter(
      (record) => record.deletedAt === null && (object === undefined || record.object === object),
    );
  }

  /** A context to call MemoryCrm through, adding `token` (its own by default) as the credential. */
  context(options: { readonly token?: string } = {}): CrmContext {
    const token = options.token ?? this.token;
    return {
      connection: {
        id: "0b7f1c2e-4d5a-4e6f-8a9b-0c1d2e3f4a5b",
        accountId: "memory-1",
        apiBase: MEMORY_CRM_API,
      },
      fetch: (request, cost) => {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${token}`);
        return this.handle(new Request(request, { headers }), cost.kind);
      },
    };
  }

  /**
   * Answers one request, as the CRM: the injected answer or seeded fault first, then the
   * credential, the rate limit, and the route. A fault before the request, or after the commit,
   * rejects as a network error does; one after the response answers a body that fails to read.
   */
  async handle(request: Request, cost: string | null = null): Promise<Response> {
    const url = new URL(request.url);
    const call = {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      cost,
      fault: null as FaultPoint | null,
    };
    this.calls.push(call);
    const injected = this.#injections.shift();
    let fault: FaultPoint | null = null;
    if (injected === undefined) fault = this.#fault?.(request.method) ?? null;
    else if (isFaultPoint(injected)) fault = injected;
    else return this.#answer(injected, request);
    call.fault = fault;
    if (fault === "before")
      throw new TypeError("network error: the request never reached MemoryCrm");

    const authorization = request.headers.get("authorization");
    if (authorization !== `Bearer ${this.token}`) return fail(401, "unauthorized");
    const limit = this.#options.rateLimit;
    if (limit) {
      if (this.#clock - this.#window.start >= limit.windowMs)
        this.#window = { start: this.#clock, count: 0 };
      if (this.#window.count >= limit.limit) {
        const wait = Math.max(
          1,
          Math.ceil((this.#window.start + limit.windowMs - this.#clock) / 1000),
        );
        return json(429, { error: { code: "rate_limited" } }, { "retry-after": String(wait) });
      }
      this.#window.count += 1;
    }

    const response = await this.#route(request, url);
    if (fault === "after_commit") {
      throw new TypeError("network error: the connection dropped before MemoryCrm answered");
    }
    if (fault === "after_response") {
      const cut = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("network error: the connection dropped mid-answer"));
        },
      });
      return new Response(cut, { status: response.status, headers: response.headers });
    }
    return response;
  }

  #answer(injection: Exclude<MemoryInjection, FaultPoint>, request: Request): Response {
    if (injection === "rate_limited")
      return json(429, { error: { code: "rate_limited" } }, { "retry-after": "2" });
    if (injection === "echo_credential") {
      // A careless CRM: the request's credential, quoted back in an error's words.
      const authorization = request.headers.get("authorization") ?? "";
      return json(401, {
        error: { code: "unauthorized", message: `invalid credential ${authorization}` },
        echoed: authorization.replace(/^Bearer /, ""),
      });
    }
    return json(injection.status, injection.body ?? {}, injection.headers ?? {});
  }

  async #route(request: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [version, resource, objectText, id, sub] = parts;
    if (version !== "v1") return fail(404, "not_found");
    const method = request.method;
    if (resource === "account" && method === "GET") {
      return json(200, {
        id: "memory-1",
        name: "MemoryCrm test account",
        user: { id: "usr_key", name: "Earshot key", email: null },
        scopes: ["records:read", "records:write", "activities:write"],
      });
    }
    if (resource === "schema" && method === "GET") return json(200, this.#schema());
    if (resource === "changes" && method === "GET") return this.#changes(url);
    if (resource === "search" && method === "GET") return this.#search(url);
    if (resource === "associations" && method === "PUT")
      return this.#associate(await bodyOf(request));
    if (resource !== "objects") return fail(404, "not_found");
    const object = asObject(objectText);
    if (object === null || (object === "meeting" && !this.capabilities.objects.meeting)) {
      return fail(404, "unknown_object");
    }
    if (id === undefined) {
      if (method === "GET") return this.#list(object, url);
      if (method === "POST") return this.#create(object, await bodyOf(request), null);
      if (method === "PUT") return this.#upsert(object, url, await bodyOf(request));
      return fail(405, "method_not_allowed");
    }
    const stored = this.#records.get(`${object}:${id}`);
    if (stored === undefined || stored.deletedAt !== null) return fail(404, "not_found");
    if (sub === undefined && method === "GET") return json(200, this.#json(stored));
    if (sub === undefined && method === "PATCH") return this.#update(stored, await bodyOf(request));
    return fail(405, "method_not_allowed");
  }

  #nextChange(): number {
    this.#changeCount += 1;
    return this.#changeCount;
  }

  #schema(): CrmSchema {
    const records = ["company", "contact", "deal"] as const;
    const marked = (object: CrmObject) =>
      isRecordObject(object)
        ? this.capabilities.idempotency.records !== "client_id"
        : this.capabilities.idempotency.activities === "upsert";
    return {
      stages: this.#stages,
      owners: this.capabilities.owners ? [MEMORY_OWNER] : [],
      associations: [
        { from: "contact", to: "company", type: "contact_company" },
        { from: "deal", to: "company", type: "deal_company" },
        ...(["note", "task", "meeting"] as const)
          .filter((from) => this.capabilities.objects[from])
          .flatMap((from) => records.map((to) => ({ from, to, type: `${from}_${to}` }))),
      ],
      properties: (["company", "contact", "deal", "note", "task", "meeting"] as const)
        .filter((object) => this.capabilities.objects[object] && marked(object))
        .map((object) => ({
          object,
          name: MEMORY_MARKER_PROPERTY,
          unique: this.#markerUnique(object),
        })),
    };
  }

  /** Whether the marker property holds unique values: where the CRM upserts by it. */
  #markerUnique(object: CrmObject): boolean {
    const mode = isRecordObject(object)
      ? this.capabilities.idempotency.records
      : this.capabilities.idempotency.activities;
    return mode === "upsert";
  }

  /** Whether an object may hold the marker property at all: activities can't, in `readback`. */
  #markerAllowed(object: CrmObject): boolean {
    return isRecordObject(object) || this.capabilities.idempotency.activities !== "readback";
  }

  #json(stored: Stored): RecordJson {
    const stage = stored.properties.dealstage;
    const label = this.#stages.find((candidate) => candidate.stageId === stage)?.label;
    return {
      object: stored.object,
      id: stored.id,
      url: appUrl(stored.object, stored.id),
      properties: stored.properties,
      labels: label === undefined ? {} : { dealstage: label },
      associations: stored.associations,
      modifiedAt: new Date(stored.modifiedAt).toISOString(),
    };
  }

  #list(object: CrmObject, url: URL): Response {
    const property = url.searchParams.get("property");
    const equals = url.searchParams.get("equals");
    const contains = url.searchParams.get("contains");
    if (property === null || (equals === null && contains === null))
      return fail(400, "filter_required");
    const results = this.records(object).filter((record) => {
      const value = record.properties[property];
      if (typeof value !== "string") return false;
      return equals !== null ? value === equals : value.includes(contains as string);
    });
    return json(200, { results: results.map((record) => this.#json(record as Stored)) });
  }

  #search(url: URL): Response {
    const object = asObject(url.searchParams.get("object") ?? undefined);
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const lag = this.#options.searchLagMs ?? 30_000;
    const results = this.records(object ?? undefined).filter(
      (record) =>
        this.#clock - record.createdAt >= lag &&
        Object.values(record.properties).some(
          (value) => typeof value === "string" && value.toLowerCase().includes(query),
        ),
    );
    return json(200, { results: results.map((record) => this.#json(record as Stored)) });
  }

  /** The first property that isn't valid for the object, or null. */
  #invalid(
    object: CrmObject,
    properties: Readonly<Record<string, CrmValue>>,
    creating: boolean,
  ): string | null {
    const allowed = PROPERTIES[object];
    for (const [name, value] of Object.entries(properties)) {
      const kind = allowed[name];
      if (kind === undefined) return name;
      if (kind === "marker" && !this.#markerAllowed(object)) return name;
      if (value === null) continue;
      switch (kind) {
        case "text":
          if (typeof value !== "string" || value.length > 1_000) return name;
          break;
        case "body":
          if (typeof value !== "string" || value === "" || value.length > 65_536) return name;
          break;
        case "email":
          if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+$/.test(value)) return name;
          break;
        case "money":
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return name;
          break;
        case "day":
          if (typeof value !== "string" || !ISO_DAY.test(value)) return name;
          break;
        case "instant":
          if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return name;
          break;
        case "stage":
          if (!this.#stages.some((stage) => stage.stageId === value)) return name;
          break;
        case "owner":
          if (!this.capabilities.owners || value !== MEMORY_OWNER.ownerId) return name;
          break;
        case "marker":
          if (typeof value !== "string" || !MARKER.test(value)) return name;
          break;
      }
    }
    if (creating) {
      for (const name of REQUIRED[object]) {
        const value = properties[name];
        if (value === undefined || value === null || value === "") return name;
      }
    }
    return null;
  }

  /** A contact other than `self` that already has this email, any case. */
  #emailTaken(email: CrmValue | undefined, self: string | null): Stored | null {
    if (typeof email !== "string") return null;
    const wanted = email.toLowerCase();
    for (const record of this.records("contact")) {
      if (
        record.id !== self &&
        typeof record.properties.email === "string" &&
        record.properties.email.toLowerCase() === wanted
      ) {
        return record as Stored;
      }
    }
    return null;
  }

  #associations(body: Record<string, unknown>): Stored["associations"] | Response {
    const list = body.associations;
    if (list === undefined) return [];
    if (this.capabilities.associations !== "inline") return fail(400, "associations_not_inline");
    if (!Array.isArray(list)) return fail(400, "invalid_value", { property: "associations" });
    const out: Stored["associations"] = [];
    for (const item of list as unknown[]) {
      const to = (item as { to?: { object?: string; id?: string } })?.to;
      const object = asObject(to?.object);
      const target = object && to?.id ? this.#records.get(`${object}:${to.id}`) : undefined;
      if (!target || target.deletedAt !== null || object === null)
        return fail(400, "invalid_association");
      out.push({ object, id: target.id, type: (item as { type: string | number }).type });
    }
    return out;
  }

  #create(object: CrmObject, body: Record<string, unknown>, upsertKey: string | null): Response {
    const properties = (body.properties ?? {}) as Record<string, CrmValue>;
    const mode = isRecordObject(object)
      ? this.capabilities.idempotency.records
      : this.capabilities.idempotency.activities;
    const clientId = body.id;
    if (clientId !== undefined && (mode !== "client_id" || typeof clientId !== "string")) {
      return fail(400, "client_id_not_supported");
    }
    // A client's id is its record's key: a retry's create collides with its first try first.
    if (typeof clientId === "string" && this.#records.has(`${object}:${clientId}`)) {
      return fail(409, "id_taken", { id: clientId });
    }
    const invalid = this.#invalid(object, properties, true);
    if (invalid !== null) return fail(400, "invalid_value", { property: invalid });
    if (object === "contact") {
      const taken = this.#emailTaken(properties.email, null);
      if (taken)
        return fail(409, "duplicate", {
          property: "email",
          existing: { object: "contact", id: taken.id },
        });
    }
    const marker = properties[MEMORY_MARKER_PROPERTY];
    if (upsertKey === null && this.#markerUnique(object) && typeof marker === "string") {
      if (
        this.records(object).some((record) => record.properties[MEMORY_MARKER_PROPERTY] === marker)
      ) {
        return fail(409, "duplicate", { property: MEMORY_MARKER_PROPERTY });
      }
    }
    const associations = this.#associations(body);
    if (associations instanceof Response) return associations;
    let id: string;
    if (typeof clientId === "string") {
      id = clientId;
    } else {
      this.#ids += 1;
      id = `${ID_PREFIX[object]}_${this.#ids}`;
    }
    const stored: Stored = {
      object,
      id,
      properties: { ...properties },
      associations,
      createdAt: this.#clock,
      modifiedAt: this.#clock,
      deletedAt: null,
      changed: this.#nextChange(),
    };
    this.#records.set(`${object}:${id}`, stored);
    return json(201, this.#json(stored));
  }

  #upsert(object: CrmObject, url: URL, body: Record<string, unknown>): Response {
    const mode = isRecordObject(object)
      ? this.capabilities.idempotency.records
      : this.capabilities.idempotency.activities;
    const by = url.searchParams.get("upsertBy");
    if (mode !== "upsert" || by !== MEMORY_MARKER_PROPERTY)
      return fail(400, "upsert_not_supported");
    const properties = (body.properties ?? {}) as Record<string, CrmValue>;
    const key = properties[by];
    if (typeof key !== "string") return fail(400, "invalid_value", { property: by });
    const existing = this.records(object).find((record) => record.properties[by] === key) as
      | Stored
      | undefined;
    if (existing === undefined) return this.#create(object, body, key);
    const invalid = this.#invalid(object, properties, false);
    if (invalid !== null) return fail(400, "invalid_value", { property: invalid });
    const associations = this.#associations(body);
    if (associations instanceof Response) return associations;
    if (Object.entries(properties).some(([name, value]) => existing.properties[name] !== value)) {
      existing.modifiedAt = this.#clock;
      existing.changed = this.#nextChange();
    }
    existing.properties = { ...existing.properties, ...properties };
    for (const link of associations) this.#link(existing, link);
    return json(200, this.#json(existing));
  }

  #update(stored: Stored, body: Record<string, unknown>): Response {
    const properties = (body.properties ?? {}) as Record<string, CrmValue>;
    const invalid = this.#invalid(stored.object, properties, false);
    if (invalid !== null) return fail(400, "invalid_value", { property: invalid });
    if (stored.object === "contact") {
      const taken = this.#emailTaken(properties.email, stored.id);
      if (taken)
        return fail(409, "duplicate", {
          property: "email",
          existing: { object: "contact", id: taken.id },
        });
    }
    const changed = Object.entries(properties).some(
      ([name, value]) => stored.properties[name] !== value,
    );
    stored.properties = { ...stored.properties, ...properties };
    if (changed) {
      stored.modifiedAt = this.#clock;
      stored.changed = this.#nextChange();
    }
    return json(200, this.#json(stored));
  }

  #link(from: Stored, link: Stored["associations"][number]): void {
    if (
      !from.associations.some(
        (existing) =>
          existing.object === link.object && existing.id === link.id && existing.type === link.type,
      )
    ) {
      from.associations.push(link);
    }
  }

  #associate(body: Record<string, unknown>): Response {
    const { from, to, type } = body as {
      from?: { object?: string; id?: string };
      to?: { object?: string; id?: string };
      type?: string | number;
    };
    const fromObject = asObject(from?.object);
    const toObject = asObject(to?.object);
    const source =
      fromObject && from?.id ? this.#records.get(`${fromObject}:${from.id}`) : undefined;
    const target = toObject && to?.id ? this.#records.get(`${toObject}:${to.id}`) : undefined;
    if (!source || source.deletedAt !== null) return fail(404, "not_found");
    if (!target || target.deletedAt !== null || toObject === null || type === undefined)
      return fail(400, "invalid_association");
    this.#link(source, { object: toObject, id: target.id, type });
    return json(200, this.#json(source));
  }

  #changes(url: URL): Response {
    const max = this.#options.maxPageSize ?? 100;
    const limitText = url.searchParams.get("limit");
    const asked = limitText === null ? max : Number(limitText);
    if (!Number.isInteger(asked) || asked < 1)
      return fail(400, "invalid_value", { property: "limit" });
    if (asked > max) return fail(400, "limit_too_large");
    const size = Math.min(asked, this.#options.pageSize ?? 50);
    const after = url.searchParams.get("after");
    const reports = this.#options.deletes ?? true;
    // Ordered by when each record last changed, a sequence that only grows: a cursor is a place in
    // it, so a record changed after the cursor comes after it, whatever its id or its time.
    const all = [...this.#records.values()]
      .filter((record) => isRecordObject(record.object) && (record.deletedAt === null || reports))
      .map((record) => ({ record, at: record.deletedAt ?? record.modifiedAt }))
      .sort((a, b) => a.record.changed - b.record.changed);
    const key = (entry: { record: Stored }) => String(entry.record.changed).padStart(12, "0");
    const rest = after === null ? all : all.filter((entry) => key(entry) > after);
    const page = rest.slice(0, size);
    const last = page.at(-1);
    return json(200, {
      results: page.map(({ record, at }) => ({
        ...this.#json(record),
        kind: record.deletedAt === null ? "changed" : "deleted",
        modifiedAt: new Date(at).toISOString(),
      })),
      next: last === undefined ? after : key(last),
      more: rest.length > page.length,
    });
  }

  // ── The harness ──

  /** The suite's way into this CRM (./harness.ts): fixtures, raw reads, and edits behind its back. */
  harness(): ConformanceHarness {
    return memoryHarness(this);
  }

  /** Makes a record directly, as a CRM user would, outside the API, its faults, and its limits. */
  seed(
    object: CrmObject,
    properties: Record<string, CrmValue>,
    associations: Stored["associations"] = [],
  ): Stored {
    this.#ids += 1;
    const id = `${ID_PREFIX[object]}_${this.#ids}`;
    const stored: Stored = {
      object,
      id,
      properties: { ...properties },
      associations: [...associations],
      createdAt: this.#clock,
      modifiedAt: this.#clock,
      deletedAt: null,
      changed: this.#nextChange(),
    };
    this.#records.set(`${object}:${id}`, stored);
    return stored;
  }

  /** A record, deleted or not. */
  stored(object: CrmObject, id: string): Stored | undefined {
    return this.#records.get(`${object}:${id}`);
  }

  /** Changes a record's properties directly, as a CRM user would; its change time moves. */
  touch(object: CrmObject, id: string, properties: Record<string, CrmValue>): Stored {
    const stored = this.#records.get(`${object}:${id}`);
    if (!stored || stored.deletedAt !== null) throw new Error(`MemoryCrm has no ${object} ${id}`);
    stored.properties = { ...stored.properties, ...properties };
    stored.modifiedAt = this.#clock;
    stored.changed = this.#nextChange();
    return stored;
  }

  /** Deletes a record directly; `changes` reports it when deletes are on. */
  delete(object: CrmObject, id: string): void {
    const stored = this.#records.get(`${object}:${id}`);
    if (stored && stored.deletedAt === null) {
      stored.deletedAt = this.#clock;
      stored.changed = this.#nextChange();
    }
  }

  /** A stage's label, by its id. */
  stageLabel(stageId: CrmValue | undefined): string | null {
    return this.#stages.find((stage) => stage.stageId === stageId)?.label ?? null;
  }
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text === "") return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

// ─── The adapter ─────────────────────────────────────────────────────────────────────────────

const CRM_NAME = "MemoryCrm";

/** Properties without the ones a write doesn't hold. */
function defined(values: Readonly<Record<string, CrmValue | undefined>>): Record<string, CrmValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, CrmValue] => entry[1] !== undefined),
  );
}

/** MemoryCrm's column of §4.3's table: its property names, and where the marker goes. */
export function memoryColumn(capabilities: Capabilities): PlanColumn {
  const recordMarker = capabilities.idempotency.records !== "client_id";
  const activityMarker = capabilities.idempotency.activities === "upsert";
  return {
    crm: CRM_NAME,
    capabilities,
    properties(draft, marker) {
      const recordKey = recordMarker ? marker : undefined;
      const activityKey = activityMarker ? marker : undefined;
      switch (draft.object) {
        case "company":
          return defined({ name: draft.values.name, [MEMORY_MARKER_PROPERTY]: recordKey });
        case "contact": {
          const { values } = draft;
          const details = { jobtitle: values.title, email: values.email, phone: values.phone };
          return draft.op === "update"
            ? defined(details)
            : defined({
                firstname: values.firstName,
                lastname: values.lastName ?? undefined,
                ...details,
                [MEMORY_MARKER_PROPERTY]: recordKey,
              });
        }
        case "deal": {
          const { values } = draft;
          const changes = {
            dealstage: values.stage?.stageId,
            amount: values.amount,
            closedate: values.closeDate,
          };
          return draft.op === "update"
            ? defined(changes)
            : defined({
                dealname: values.name,
                pipeline: values.pipelineId ?? undefined,
                ...changes,
                [MEMORY_MARKER_PROPERTY]: recordKey,
              });
        }
        case "note":
          return defined({
            body: draft.values.body,
            timestamp: draft.values.at,
            [MEMORY_MARKER_PROPERTY]: activityKey,
          });
        case "task":
          return defined({
            subject: draft.values.title,
            body: draft.values.body,
            due: draft.values.dueAt,
            status: "open",
            owner: draft.values.ownerId ?? undefined,
            [MEMORY_MARKER_PROPERTY]: activityKey,
          });
        case "meeting":
          return defined({
            title: draft.values.title,
            body: draft.values.body,
            start: draft.values.startsAt,
            [MEMORY_MARKER_PROPERTY]: activityKey,
          });
      }
    },
    checkField: (_object, field) => CHECK_PROPERTY[field],
  };
}

/** How a create keeps itself to one in MemoryCrm, by its object. */
function modeOf(capabilities: Capabilities, object: CrmObject): IdempotencyMode {
  return isRecordObject(object)
    ? capabilities.idempotency.records
    : capabilities.idempotency.activities;
}

/** A write's requests, from the refs it points at: what both `requests` and `execute` build from. */
export function memorySpecs(
  write: PlannedWrite,
  refOf: (ref: WriteRef) => ExternalRef,
  capabilities: Capabilities,
): RequestSpec[] {
  const headers = { accept: "application/json" };
  switch (write.op) {
    case "create": {
      const associations = write.associate.map((link) => {
        const to = refOf(link.to);
        return { to: { object: to.object, id: to.id }, type: link.type };
      });
      const body = {
        properties: write.properties,
        ...(associations.length > 0 ? { associations } : {}),
      };
      switch (modeOf(capabilities, write.object)) {
        case "upsert":
          return [
            {
              method: "PUT",
              path: `/v1/objects/${write.object}?upsertBy=${MEMORY_MARKER_PROPERTY}`,
              headers,
              body,
            },
          ];
        case "client_id":
          return [
            {
              method: "POST",
              path: `/v1/objects/${write.object}`,
              headers,
              body: { id: markerUuid(write.marker), ...body },
            },
          ];
        case "readback":
          return [{ method: "POST", path: `/v1/objects/${write.object}`, headers, body }];
      }
      break;
    }
    case "update": {
      if (write.ref === null) throw new TypeError("an update names its record");
      const ref = refOf(write.ref);
      return [
        {
          method: "PATCH",
          path: `/v1/objects/${ref.object}/${encodeURIComponent(ref.id)}`,
          headers,
          body: { properties: write.properties },
        },
      ];
    }
    case "associate": {
      if (write.ref === null) throw new TypeError("an association names the record it's from");
      const from = refOf(write.ref);
      return write.associate.map((link) => {
        const to = refOf(link.to);
        return {
          method: "PUT",
          path: "/v1/associations",
          headers,
          body: {
            from: { object: from.object, id: from.id },
            to: { object: to.object, id: to.id },
            type: link.type,
          },
        };
      });
    }
  }
  throw new TypeError(`no requests for a ${write.op}`);
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Sends one request through the context, reading its whole answer; a lost one is `transient`. */
async function send(
  spec: RequestSpec,
  ctx: CrmContext,
  kind: "read" | "write" | "search",
): Promise<Answer> {
  let response: Response;
  try {
    response = await ctx.fetch(requestOf(spec, ctx), { kind });
  } catch (cause) {
    if (cause instanceof CrmError) throw cause;
    throw networkError(cause, { crm: CRM_NAME });
  }
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text === "" ? null : JSON.parse(text);
  } catch (cause) {
    throw networkError(cause, { crm: CRM_NAME });
  }
  return { status: response.status, headers: response.headers, body };
}

/** The `CrmError` for an answer that wasn't a success, from MemoryCrm's error body. */
function errorOf(answer: Answer): CrmError {
  const error = ((answer.body as { error?: unknown } | null)?.error ?? {}) as {
    code?: unknown;
    property?: unknown;
    existing?: { object?: unknown; id?: unknown };
  };
  const object = asObject(
    typeof error.existing?.object === "string" ? error.existing.object : undefined,
  );
  const existingId = typeof error.existing?.id === "string" ? error.existing.id : null;
  return errorFromResponse(
    answer.status,
    {
      code: typeof error.code === "string" ? error.code : null,
      field: typeof error.property === "string" ? (FIELD_OF[error.property] ?? null) : null,
      existing:
        object !== null && existingId !== null
          ? { object, id: existingId, url: appUrl(object, existingId) }
          : null,
    },
    answer.headers,
    { crm: CRM_NAME },
  );
}

function ok(answer: Answer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

/** A record's ref from MemoryCrm's answer. */
function refFrom(body: unknown): ExternalRef {
  const record = body as { object?: unknown; id?: unknown };
  const object = asObject(typeof record?.object === "string" ? record.object : undefined);
  if (object === null || typeof record.id !== "string") {
    throw new CrmError("unknown", "MemoryCrm answered without a record");
  }
  return { object, id: record.id, url: appUrl(object, record.id) };
}

/** A scalar property as a field value; anything else is none. */
function scalar(value: CrmValue | undefined): FieldValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

/**
 * MemoryCrm's adapter: plans by `memoryColumn`, requests by `memorySpecs`, and I/O only through
 * `ctx.fetch`. The conformance suite's mutation tests break copies of it on purpose.
 */
export function memoryCrmAdapter(config: {
  readonly provider: Exclude<CrmProvider, "demo">;
  readonly capabilities: Capabilities;
}): CrmAdapter {
  const { capabilities } = config;
  const column = memoryColumn(capabilities);

  async function lookup(write: PlannedWrite, ctx: CrmContext): Promise<ExternalRef | null> {
    const mode = modeOf(capabilities, write.object);
    if (mode === "client_id") {
      const id = markerUuid(write.marker);
      const answer = await send(
        { method: "GET", path: `/v1/objects/${write.object}/${id}` },
        ctx,
        "read",
      );
      if (answer.status === 404) return null;
      if (!ok(answer)) throw errorOf(answer);
      return refFrom(answer.body);
    }
    const byLine = mode === "readback" && !isRecordObject(write.object);
    const query = byLine
      ? `property=body&contains=${encodeURIComponent(`ref ${write.marker}`)}`
      : `property=${MEMORY_MARKER_PROPERTY}&equals=${write.marker}`;
    const answer = await send(
      { method: "GET", path: `/v1/objects/${write.object}?${query}` },
      ctx,
      "read",
    );
    if (!ok(answer)) throw errorOf(answer);
    const results = ((answer.body as { results?: unknown[] })?.results ?? []) as {
      properties?: Record<string, CrmValue>;
    }[];
    const found = results.find(
      (result) => !byLine || hasActivityLine(String(result.properties?.body ?? ""), write.marker),
    );
    return found === undefined ? null : refFrom(found);
  }

  return {
    provider: config.provider,
    capabilities,
    plan: (input) => buildPlan(input, column),
    requests(plan, ctx) {
      return plan.writes.flatMap((write) =>
        memorySpecs(write, (ref) => previewRef(ref, plan), capabilities).map((spec) =>
          previewOf(spec, ctx, { credential: true }),
        ),
      );
    },
    async verify(ctx) {
      const answer = await send({ method: "GET", path: "/v1/account" }, ctx, "read");
      if (!ok(answer)) throw errorOf(answer);
      const body = answer.body as {
        id: string;
        name: string | null;
        user: { id: string; name: string | null; email: string | null } | null;
        scopes: string[];
      };
      return { accountId: body.id, accountName: body.name, actor: body.user, scopes: body.scopes };
    },
    async schema(ctx) {
      const answer = await send({ method: "GET", path: "/v1/schema" }, ctx, "read");
      if (!ok(answer)) throw errorOf(answer);
      return answer.body as CrmSchema;
    },
    async get(ref, fields, ctx) {
      const answer = await send(
        { method: "GET", path: `/v1/objects/${ref.object}/${encodeURIComponent(ref.id)}` },
        ctx,
        "read",
      );
      if (answer.status === 404) return null;
      if (!ok(answer)) throw errorOf(answer);
      const record = answer.body as RecordJson;
      const values: Record<string, FieldValue> = {};
      for (const field of fields) {
        // A stage reads by its label, as the mirror shows it (§4.3).
        values[field] =
          field === "dealstage"
            ? (record.labels.dealstage ?? null)
            : scalar(record.properties[field]);
      }
      return { ref: refFrom(record), values };
    },
    async reconcile(write, _done, ctx) {
      if (write.op !== "create") return null;
      const found = await lookup(write, ctx);
      return found === null ? null : { index: write.index, op: "found", ref: found };
    },
    async execute(write, done, ctx) {
      const specs = memorySpecs(write, (ref) => outcomeRef(ref, done), capabilities);
      switch (write.op) {
        case "create": {
          const mode = modeOf(capabilities, write.object);
          if (mode === "readback") {
            const found = await lookup(write, ctx);
            if (found !== null) return { index: write.index, op: "found", ref: found };
          }
          const answer = await send(specs[0] as RequestSpec, ctx, "write");
          const code = (answer.body as { error?: { code?: unknown } } | null)?.error?.code;
          if (mode === "client_id" && answer.status === 409 && code === "id_taken") {
            const found = await lookup(write, ctx);
            if (found !== null) return { index: write.index, op: "found", ref: found };
          }
          if (!ok(answer)) throw errorOf(answer);
          return {
            index: write.index,
            op: answer.status === 201 ? "created" : "found",
            ref: refFrom(answer.body),
          };
        }
        case "update": {
          const answer = await send(specs[0] as RequestSpec, ctx, "write");
          if (!ok(answer)) throw errorOf(answer);
          return { index: write.index, op: "updated", ref: refFrom(answer.body) };
        }
        case "associate": {
          let ref: ExternalRef | null = null;
          for (const spec of specs) {
            const answer = await send(spec, ctx, "write");
            if (!ok(answer)) throw errorOf(answer);
            ref = refFrom(answer.body);
          }
          if (ref === null)
            throw new CrmError("unknown", "an association write had nothing to link");
          return { index: write.index, op: "associated", ref };
        }
      }
    },
    async changes(cursor, ctx) {
      const after = cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`;
      const answer = await send(
        { method: "GET", path: `/v1/changes?limit=100${after}` },
        ctx,
        "read",
      );
      if (!ok(answer)) throw errorOf(answer);
      const body = answer.body as {
        results: (RecordJson & { kind: "changed" | "deleted" })[];
        next: string | null;
        more: boolean;
      };
      const changes: CrmChange[] = body.results.map((record) => ({
        ref: refFrom(record),
        kind: record.kind,
        name: recordName(record.object, record.properties),
        values: mirrorValues(record.object, record.properties, record.labels.dealstage ?? null),
        at: record.modifiedAt,
      }));
      return { changes, cursor: body.next ?? cursor ?? "", more: body.more };
    },
  };
}

/** A record's name as MemoryCrm holds it. */
function recordName(
  object: CrmObject,
  properties: Readonly<Record<string, CrmValue>>,
): string | null {
  switch (object) {
    case "company":
      return scalar(properties.name) === null ? null : String(properties.name);
    case "contact": {
      const name = [properties.firstname, properties.lastname]
        .filter((part) => typeof part === "string")
        .join(" ");
      return name === "" ? null : name;
    }
    case "deal":
      return typeof properties.dealname === "string" ? properties.dealname : null;
    default:
      return null;
  }
}

/** A record's values as the mirror holds them: a deal's stage by its label. */
function mirrorValues(
  object: CrmObject,
  properties: Readonly<Record<string, CrmValue>>,
  stageLabel: string | null,
): MirrorValues {
  switch (object) {
    case "deal":
      return {
        stage: stageLabel,
        amount: scalar(properties.amount),
        closeDate: scalar(properties.closedate),
      };
    case "contact":
      return {
        title: scalar(properties.jobtitle),
        email: scalar(properties.email),
        phone: scalar(properties.phone),
      };
    default:
      return {};
  }
}

// ─── The harness ─────────────────────────────────────────────────────────────────────────────

function memoryHarness(crm: MemoryCrm): ConformanceHarness {
  const rawOf = (stored: Readonly<Stored>): RawRecord => ({
    ref: { object: stored.object, id: stored.id, url: appUrl(stored.object, stored.id) },
    properties: { ...stored.properties },
  });
  const seenOf = (stored: Readonly<Stored>): MirrorValues =>
    mirrorValues(stored.object, stored.properties, crm.stageLabel(stored.properties.dealstage));
  const companyLink = (company: ExternalRef | null, object: "contact" | "deal") =>
    company === null
      ? []
      : [{ object: "company" as const, id: company.id, type: `${object}_company` }];
  const EDIT_PROPERTY: Readonly<Record<FixtureEdit["field"], (object: CrmObject) => string>> = {
    name: (object) =>
      object === "deal" ? "dealname" : object === "contact" ? "firstname" : "name",
    stage: () => "dealstage",
    amount: () => "amount",
    closeDate: () => "closedate",
    title: () => "jobtitle",
    email: () => "email",
    phone: () => "phone",
  };
  return {
    context: () => crm.context(),
    secret: crm.token,
    refusedContext: () => crm.context({ token: "mem_tok_refused_00000000" }),
    stageForm: "label",
    async make(fixture: Fixture): Promise<Made> {
      let stored: Stored;
      switch (fixture.object) {
        case "company":
          stored = crm.seed("company", { name: fixture.name });
          break;
        case "contact": {
          const [first, ...rest] = fixture.name.split(" ");
          stored = crm.seed(
            "contact",
            {
              firstname: first ?? fixture.name,
              lastname: rest.length > 0 ? rest.join(" ") : null,
              jobtitle: fixture.title,
              email: fixture.email,
              phone: fixture.phone,
            },
            companyLink(fixture.company, "contact"),
          );
          break;
        }
        case "deal":
          stored = crm.seed(
            "deal",
            {
              dealname: fixture.name,
              pipeline: fixture.stage.pipelineId,
              dealstage: fixture.stage.stageId,
              amount: fixture.amount,
              closedate: fixture.closeDate,
            },
            companyLink(fixture.company, "deal"),
          );
          break;
      }
      return { ref: rawOf(stored).ref, seen: seenOf(stored) };
    },
    async read(ref) {
      const stored = crm.stored(ref.object, ref.id);
      return stored === undefined || stored.deletedAt !== null ? null : rawOf(stored);
    },
    async find(object, marker) {
      const uuid = markerUuid(marker);
      return crm
        .records(object)
        .filter(
          (record) =>
            record.properties[MEMORY_MARKER_PROPERTY] === marker ||
            record.id === uuid ||
            (typeof record.properties.body === "string" &&
              hasActivityLine(record.properties.body, marker)),
        )
        .map(rawOf);
    },
    async associations(ref) {
      const stored = crm.stored(ref.object, ref.id);
      return (stored?.associations ?? []).map((link) => ({
        object: link.object,
        id: link.id,
        url: null,
      }));
    },
    async edit(ref, edit) {
      // Later than anything before it, as an edit in the CRM would be.
      crm.advance(1_000);
      const stored = crm.touch(ref.object, ref.id, {
        [EDIT_PROPERTY[edit.field](ref.object)]: edit.value,
      });
      return seenOf(stored);
    },
    async remove(ref) {
      crm.advance(1_000);
      crm.delete(ref.object, ref.id);
    },
    respond(answer) {
      crm.inject(answer);
    },
    refusedValue: { field: "email", value: "not an email" },
  };
}
