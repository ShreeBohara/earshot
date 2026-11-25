// The conformance suite's checks (Phase 6 spec §4.2; docs/adr/0041): §4.2's nine groups, each check
// a function that throws when the adapter falls short, so `runConformance` can run them as Vitest
// tests and the suite's own tests can run them against adapters broken on purpose. Every adapter
// passes the same checks; what one can't do it declares in `ConformanceOptions.cannot`, with why,
// and the check it skips says so in its name. A check the harness can't support without a reason
// fails rather than skip silently. Node only, under Vitest: no Worker imports it.
import type { CrmMappedStage, CrmObject, ExternalRef, FieldValue } from "@earshot/core";
import { normalizeName } from "@earshot/understanding/names";
import { expect } from "vitest";
import type {
  CrmAdapter,
  CrmContext,
  CrmSchema,
  PlannedWrite,
  PlanResult,
  RenderContext,
  RequestPreview,
  WriteOutcome,
  WritePlan,
} from "../adapter";
import { CrmError } from "../errors";
import { idempotencyKey, marker } from "../markers";
import { defaultMapping, ownerFor } from "../plan/mapping";
import { CHECKED_FIELDS, type CheckedField } from "../plan/table";
import { CREDENTIAL_PREVIEW, holdsSecret } from "../redact";
import { checkSentences, outcomeRef, resolvePreview } from "../render";
import type { ConformanceHarness, Made } from "../testing/harness";
import { testUuid } from "../testing/proposals";
import { CASES, type Case, type CaseWorld, caseInput, needsDeals } from "./cases";

/** What a CRM or its harness can't do, which a check needs: each skipped check names the reason. */
export type Inability =
  /** No golden files for this adapter. */
  | "golden"
  /** `verify` can't name the actor whose name writes carry. */
  | "actor"
  /** The CRM takes no credential to refuse. */
  | "auth"
  /** The harness can't make the CRM answer 429. */
  | "rateLimit"
  /** The harness can't make the CRM quote a credential back. */
  | "echo"
  /** The harness knows no value the CRM refuses. */
  | "refusedValue"
  /** The CRM holds no unique value a person's email could take. */
  | "duplicates"
  /** `changes` doesn't report deleted records. */
  | "deletes";

/** Golden plans and requests: where the files live, and what they're planned against. */
export interface GoldenOptions {
  /** The directory of the golden files, an absolute path. Regenerating them is a deliberate `-u`. */
  readonly dir: string;
  /** The schema the golden plans are made against: a representative one of the adapter's CRM. */
  readonly schema: CrmSchema;
  /** The connection the golden requests render against. */
  readonly render: RenderContext;
  /** The records the linked cases point at; generic ids by default. */
  readonly refs?: {
    readonly company: ExternalRef;
    readonly contact: ExternalRef;
    readonly deal: ExternalRef;
  };
}

/** A request as it reached `CrmContext.fetch`, before the credential: what the limits check reads. */
export interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly cost: "read" | "write" | "search";
}

export interface ConformanceOptions {
  /** The run's name, in its title; the adapter's provider by default. */
  readonly name?: string;
  /** Golden plans and requests; absent only with `cannot.golden`. */
  readonly golden?: GoldenOptions;
  /** What the adapter or its CRM can't do, each with why. */
  readonly cannot?: Partial<Readonly<Record<Inability, string>>>;
  /** How many records a page of `changes` holds here, so the suite makes more than two pages' worth. */
  readonly changesPageSize: number;
  /** The CRM's documented page and batch sizes: a request that exceeds one, in words, or null. */
  readonly limits: (request: SentRequest) => string | null;
  /** Each check's time limit, in ms (default 30 s). */
  readonly timeoutMs?: number;
}

/** One check: its name, why it's skipped (if it is), and what it does. */
export interface Check {
  readonly name: string;
  readonly skip: string | null;
  readonly run: () => Promise<void>;
}

/** One of §4.2's nine groups. */
export interface CheckGroup {
  readonly id:
    | "connection"
    | "plans"
    | "writes"
    | "twice"
    | "lost"
    | "live"
    | "errors"
    | "changes"
    | "limits";
  readonly title: string;
  readonly checks: readonly Check[];
}

/** The suite, built for one adapter and harness: set it up, run its groups, tear it down. */
export interface ConformanceSuite {
  readonly title: string;
  readonly groups: readonly CheckGroup[];
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

/** What a run has seen: every request sent, every preview made, and everything thrown. */
interface RunLog {
  readonly sent: SentRequest[];
  readonly previews: RequestPreview[];
  readonly thrown: unknown[];
}

/** Whether a stand-in context drops the answer of the next request that changes something. */
interface Drop {
  next: boolean;
}

function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

/** The context, recording each request (without its credential) and dropping an answer on demand. */
function recording(ctx: CrmContext, log: RunLog, drop: Drop): CrmContext {
  return {
    connection: ctx.connection,
    async fetch(request, cost) {
      const text = await request.clone().text();
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const { authorization: _, ...headers } = lowerHeaders(request.headers);
      log.sent.push({ method: request.method, url: request.url, headers, body, cost: cost.kind });
      if (drop.next && request.method !== "GET") {
        drop.next = false;
        // The CRM commits; its answer is lost on the way back.
        await ctx.fetch(request, cost);
        throw new TypeError("network error: the answer was lost (the conformance suite drops it)");
      }
      return ctx.fetch(request, cost);
    },
  };
}

/** The adapter, with everything it throws kept for the secrets check. */
function guarded(adapter: CrmAdapter, log: RunLog): CrmAdapter {
  const keep =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await call(...args);
      } catch (error) {
        log.thrown.push(error);
        throw error;
      }
    };
  const keepSync =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return call(...args);
      } catch (error) {
        log.thrown.push(error);
        throw error;
      }
    };
  return {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    plan: keepSync((input) => adapter.plan(input)),
    requests: keepSync((plan, ctx) => adapter.requests(plan, ctx)),
    verify: keep((ctx) => adapter.verify(ctx)),
    schema: keep((ctx) => adapter.schema(ctx)),
    get: keep((ref, fields, ctx) => adapter.get(ref, fields, ctx)),
    reconcile: keep((write, done, ctx) => adapter.reconcile(write, done, ctx)),
    execute: keep((write, done, ctx) => adapter.execute(write, done, ctx)),
    changes: keep((cursor, ctx) => adapter.changes(cursor, ctx)),
  };
}

/** What a call threw, or a failure if it didn't. */
async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail, but it succeeded");
}

/** A ref by what it is and its id, without the link, which reads may or may not carry. */
function same(ref: ExternalRef): { object: CrmObject; id: string } {
  return { object: ref.object, id: ref.id };
}

/** The outcome op a write's first run reports. */
function firstOp(write: PlannedWrite): WriteOutcome["op"] {
  return write.op === "create" ? "created" : write.op === "update" ? "updated" : "associated";
}

/** The op a write's repeat reports: a create finds its first try. */
function againOp(write: PlannedWrite): WriteOutcome["op"] {
  return write.op === "create" ? "found" : firstOp(write);
}

/** A preview or a request, without its credential header, for comparing the two. */
function withoutCredential(request: {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}) {
  const { authorization: _, ...headers } = request.headers;
  return { method: request.method, url: request.url, headers, body: request.body ?? null };
}

/** A short tag for this run and check, so fixtures and emails never collide across checks or runs. */
function tag(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Builds the suite for one adapter and harness. `runConformance` runs it as Vitest tests; the suite's
 * own tests run single checks against broken adapters.
 */
export function conformanceSuite(
  adapterFactory: () => CrmAdapter,
  harness: ConformanceHarness,
  options: ConformanceOptions,
): ConformanceSuite {
  const log: RunLog = { sent: [], previews: [], thrown: [] };
  const drop: Drop = { next: false };
  const cannot = options.cannot ?? {};
  let built: CrmAdapter | null = null;
  const adapter = (): CrmAdapter => {
    built ??= guarded(adapterFactory(), log);
    return built;
  };
  const { capabilities, provider } = adapterFactory();
  let ctxValue: CrmContext | null = null;
  const ctx = (): CrmContext => {
    ctxValue ??= recording(harness.context(), log, drop);
    return ctxValue;
  };

  // Filled in by setup: the CRM's schema and the mapping made from it, the fields live checks name,
  // and the golden cases' fixed keys and markers.
  let schema: CrmSchema | null = null;
  const crmFields = new Map<CheckedField, string>();
  const goldenMarkers = new Map<string, { key: string; markers: string[] }>();

  /** Why a check can't run: the inability's reason, or a failure when the harness gives no means and no reason. */
  function needs(inability: Inability, means: boolean): string | null {
    const reason = cannot[inability];
    if (reason !== undefined) return reason;
    return means ? null : "";
  }

  /** A check, skipped with its reason, or failing when its means are missing and nothing says why. */
  function check(name: string, skip: string | null, run: () => Promise<void>): Check {
    if (skip === "") {
      return {
        name,
        skip: null,
        run: async () => {
          throw new Error(
            `the harness can't support "${name}", and ConformanceOptions.cannot doesn't say why`,
          );
        },
      };
    }
    return { name, skip, run };
  }

  const theSchema = (): CrmSchema => {
    if (schema === null) throw new Error("the suite wasn't set up: call setup() first");
    return schema;
  };

  /** A mapping from a schema, with the rep matched to its first owner where tasks can be assigned. */
  function mappingFor(source: CrmSchema) {
    const owner = capabilities.owners ? source.owners[0] : undefined;
    const reps = owner?.email ? [{ userId: "u_rep", email: owner.email }] : [];
    const mapping = defaultMapping(source, capabilities, { reps });
    return { mapping, rep: { ownerId: ownerFor(mapping, "u_rep"), timeZone: "America/Chicago" } };
  }

  /** Two stages: one a fixture deal sits at, and one a deal update moves it to, read exactly. */
  function stagesOf(source: CrmSchema, pipelineId: string | null) {
    const mapped = mappingFor(source).mapping.stages;
    const unique = mapped.filter(
      (stage) =>
        (pipelineId === null || stage.pipelineId === pipelineId) &&
        mapped.filter((other) => normalizeName(other.label) === normalizeName(stage.label))
          .length === 1,
    );
    const [first, second] = unique;
    if (first === undefined) throw new Error("the schema has no stage a rep's words read exactly");
    const from = source.stages.find((stage) => stage.stageId === first.stageId) ?? source.stages[0];
    if (from === undefined) throw new Error("the schema lists no stages");
    return { from, to: (second ?? first) as CrmMappedStage };
  }

  /** The value a fixture deal's stage has in the mirror, by the harness's form. */
  const stageSeen = (stage: { stageId: string; label: string }) =>
    harness.stageForm === "id" ? stage.stageId : stage.label;

  /** The golden world: fixed records, values, ids, and markers, against the golden schema. */
  function goldenWorld(caseItem: Case): CaseWorld {
    const golden = options.golden;
    if (!golden) throw new Error("no golden options");
    const refs = golden.refs ?? {
      company: { object: "company", id: "1001", url: null },
      contact: { object: "contact", id: "2001", url: null },
      deal: { object: "deal", id: "3001", url: null },
    };
    const { mapping, rep } = mappingFor(golden.schema);
    const stages = stagesOf(golden.schema, mapping.newDeals.pipelineId);
    const fixed = goldenMarkers.get(caseItem.id);
    if (!fixed) throw new Error("the suite wasn't set up: call setup() first");
    const index = CASES.indexOf(caseItem);
    return {
      schema: golden.schema,
      mapping,
      rep,
      company: { entityId: testUuid(0x6101), ref: refs.company, name: "Acme" },
      contact: { entityId: testUuid(0x6102), ref: refs.contact, name: "Dana Lee" },
      deal: { entityId: testUuid(0x6103), ref: refs.deal, name: "Acme renewal" },
      seen: {
        contact: { title: "Director", email: "dana.lee@acme.example", phone: "555-0100" },
        deal: { stage: stageSeen(stages.from), amount: 30_000, closeDate: "2026-12-31" },
      },
      stage: stages.to,
      email: "priya.raman@acme.example",
      proposalId: testUuid(0x3100 + index),
      reviewId: testUuid(0x7100 + index),
      key: fixed.key,
      markers: fixed.markers,
    };
  }

  /** A live world: fresh fixtures in the CRM, a fresh email, and fresh ids, keys, and markers. */
  async function liveWorld(): Promise<CaseWorld> {
    const source = theSchema();
    const { mapping, rep } = mappingFor(source);
    const stages = stagesOf(source, mapping.newDeals.pipelineId);
    const run = tag();
    const company = await harness.make({ object: "company", name: `Acme ${run}` });
    const contact = await harness.make({
      object: "contact",
      name: `Dana Lee${run}`,
      title: "Director",
      email: `dana.lee.${run}@example.test`,
      phone: "555-0100",
      company: company.ref,
    });
    const deal = capabilities.objects.deal
      ? await harness.make({
          object: "deal",
          name: `Acme renewal ${run}`,
          stage: stages.from,
          amount: 30_000,
          closeDate: "2026-12-31",
          company: company.ref,
        })
      : null;
    const proposalId = crypto.randomUUID();
    const reviewId = crypto.randomUUID();
    const key = await idempotencyKey(proposalId, reviewId);
    const markers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((index) => marker(key, index)));
    const mirror = (made: Made, name: string) => ({
      entityId: crypto.randomUUID(),
      ref: made.ref,
      name,
    });
    return {
      schema: source,
      mapping,
      rep,
      company: mirror(company, `Acme ${run}`),
      contact: mirror(contact, `Dana Lee${run}`),
      deal: deal
        ? mirror(deal, `Acme renewal ${run}`)
        : {
            entityId: crypto.randomUUID(),
            ref: { object: "deal", id: "none", url: null },
            name: "",
          },
      seen: { contact: contact.seen, deal: deal?.seen ?? {} },
      stage: stages.to,
      email: `priya.raman.${run}@example.test`,
      proposalId,
      reviewId,
      key,
      markers,
    };
  }

  /** A case's plan, which must be a plan; a refusal fails the check with its words. */
  function planOf(result: PlanResult, caseItem: Case): WritePlan {
    if (!result.ok) {
      throw new Error(`${caseItem.id} didn't plan: ${result.kind} (${result.reason})`);
    }
    return result.plan;
  }

  /** The skip reason for a case the CRM can't hold: its deals, for a deal update or a new deal. */
  const cantHold = (caseItem: Case): string | null =>
    needsDeals(caseItem) && !capabilities.objects.deal
      ? "the CRM has no deals, and the plan refuses it as unsupported (see plans)"
      : null;

  /** Each write once, in order, with the outcomes before it. */
  async function executeAll(plan: WritePlan): Promise<WriteOutcome[]> {
    const done: WriteOutcome[] = [];
    for (const write of plan.writes) {
      const outcome = await adapter().execute(write, done, ctx());
      expect(outcome.index, `write ${write.index}'s outcome`).toBe(write.index);
      expect(outcome.op, `write ${write.index}'s op`).toBe(firstOp(write));
      done.push(outcome);
    }
    return done;
  }

  /** The record each create made: exactly one holds its marker, the one its outcome names. */
  async function expectOne(write: PlannedWrite, outcome: WriteOutcome): Promise<void> {
    const found = await harness.find(write.object, write.marker);
    expect(
      found.map((record) => same(record.ref)),
      `the ${write.object} write ${write.index} made`,
    ).toEqual([same(outcome.ref)]);
  }

  /**
   * The fields `get` reads back as written, for the record a deal update or a contact proposal
   * writes itself; an activity's new record is held to its properties instead.
   */
  function writtenValues(write: PlannedWrite, world: CaseWorld, caseItem: Case) {
    const fields: Partial<Record<CheckedField, FieldValue>> = {};
    const linked = caseItem.target === "linked";
    if (write.object === "deal" && caseItem.type === "deal_update") {
      fields.stage = stageSeen(world.stage);
      fields.amount = linked ? 48_000 : 25_000;
      fields.closeDate = linked ? "2026-12-15" : "2027-01-15";
    } else if (write.object === "contact" && caseItem.type === "contact") {
      fields.title = linked ? "Chief Operating Officer" : "VP of Operations";
      fields.email = world.email;
      fields.phone = linked ? "555-0177" : "555-0142";
    }
    return fields;
  }

  // ── 1. Connection ──

  const connection: CheckGroup = {
    id: "connection",
    title: "connection",
    checks: [
      check(
        cannot.actor
          ? `verify names the account and the scopes (the actor skipped: ${cannot.actor})`
          : "verify names the account, the actor, and the scopes",
        null,
        async () => {
          const info = await adapter().verify(ctx());
          expect(info.accountId, "the account").toMatch(/\S/);
          expect(Array.isArray(info.scopes), "the scopes").toBe(true);
          if (!cannot.actor) {
            expect(info.actor, "the actor").not.toBeNull();
            expect(info.actor?.id, "the actor's id").toMatch(/\S/);
          }
        },
      ),
      check(
        "schema lists stages, owners when tasks can be assigned, and an association type for every pair the plans use",
        null,
        async () => {
          const live = await adapter().schema(ctx());
          expect(live.stages.length, "the stages").toBeGreaterThan(0);
          if (capabilities.owners) expect(live.owners.length, "the owners").toBeGreaterThan(0);
          else expect(live.owners, "the owners of a CRM without them").toEqual([]);
          const world = await liveWorld();
          const pairs = new Set<string>();
          for (const caseItem of CASES) {
            const result = adapter().plan(caseInput(caseItem, world));
            if (!result.ok) continue;
            for (const write of result.plan.writes) {
              for (const link of write.associate) {
                const to =
                  "write" in link.to
                    ? (result.plan.writes[link.to.write]?.object as CrmObject)
                    : link.to.object;
                pairs.add(`${write.object}→${to}`);
              }
            }
          }
          const listed = new Set(live.associations.map((type) => `${type.from}→${type.to}`));
          expect(
            [...pairs].filter((pair) => !listed.has(pair)),
            "pairs without a type",
          ).toEqual([]);
        },
      ),
    ],
  };

  // ── 2. Plans ──

  const golden = options.golden;
  const goldenSkip = golden ? null : needs("golden", false);
  const plans: CheckGroup = {
    id: "plans",
    title: "plans",
    checks: [
      ...CASES.map((caseItem) =>
        check(
          `${caseItem.id}: the plan and its requests match the golden file`,
          goldenSkip,
          async () => {
            if (!golden) return;
            const world = goldenWorld(caseItem);
            const result = adapter().plan(caseInput(caseItem, world));
            const requests = result.ok ? adapter().requests(result.plan, golden.render) : null;
            if (requests) log.previews.push(...requests);
            const checks = result.ok
              ? checkSentences(result.plan.checks, { stages: golden.schema.stages })
              : null;
            const file = `${golden.dir.replace(/\/+$/, "")}/${caseItem.id}.json`;
            const text = `${JSON.stringify({ result, requests, checks }, null, 2)}\n`;
            await expect(text).toMatchFileSnapshot(file);
          },
        ),
      ),
      check(
        "the same input plans and previews the same, and planning calls no CRM",
        null,
        async () => {
          const world = await liveWorld();
          const before = log.sent.length;
          for (const caseItem of CASES) {
            const input = caseInput(caseItem, world);
            const first = adapter().plan(input);
            expect(adapter().plan(input), caseItem.id).toEqual(first);
            if (first.ok) {
              expect(adapter().requests(first.plan, ctx()), caseItem.id).toEqual(
                adapter().requests(first.plan, ctx()),
              );
            } else {
              expect(first.kind, `${caseItem.id} refused`).toBe("unsupported");
              expect(cantHold(caseItem), `${caseItem.id} refused`).not.toBeNull();
            }
          }
          expect(log.sent.length, "requests sent while planning").toBe(before);
        },
      ),
    ],
  };

  // ── 3. Writes ──

  const writes: CheckGroup = {
    id: "writes",
    title: "writes",
    checks: CASES.map((caseItem) =>
      check(
        `${caseItem.id}: lands exactly its records and associations, as sent, and sends what requests() previews`,
        cantHold(caseItem),
        async () => {
          const world = await liveWorld();
          const plan = planOf(adapter().plan(caseInput(caseItem, world)), caseItem);
          const previews = adapter().requests(plan, ctx());
          log.previews.push(...previews);
          const from = log.sent.length;
          const done = await executeAll(plan);

          const sent = log.sent
            .slice(from)
            .filter((request) => request.method !== "GET")
            .map(withoutCredential);
          const previewed = previews
            .filter((preview) => preview.method !== "GET")
            .map((preview) => withoutCredential(resolvePreview(preview, done)));
          expect(sent, "what execute sent, against what requests() previewed").toEqual(previewed);

          for (const write of plan.writes) {
            const outcome = done[write.index] as WriteOutcome;
            if (write.op === "create") {
              await expectOne(write, outcome);
              const raw = await harness.find(write.object, write.marker);
              expect(raw[0]?.properties, `the ${write.object}'s properties`).toMatchObject(
                write.properties,
              );
            }
            if (write.op === "update") {
              const raw = await harness.read(outcome.ref);
              expect(raw?.properties, `the updated ${write.object}`).toMatchObject(
                write.properties,
              );
            }
            if (write.associate.length > 0) {
              const source =
                write.op === "associate" && write.ref ? outcomeRef(write.ref, done) : outcome.ref;
              const links = (await harness.associations(source)).map(same);
              for (const link of write.associate) {
                expect(links, `write ${write.index}'s links`).toContainEqual(
                  same(outcomeRef(link.to, done)),
                );
              }
            }
            const fields = writtenValues(write, world, caseItem);
            const names = Object.keys(fields) as CheckedField[];
            if (names.length > 0 && write.op !== "associate") {
              const record = await adapter().get(
                outcome.ref,
                names.map((field) => crmField(field)),
                ctx(),
              );
              expect(record, `get of the ${write.object}`).not.toBeNull();
              for (const field of names) {
                expect(record?.values[crmField(field)], `get reads ${field} as written`).toEqual(
                  fields[field],
                );
              }
            }
          }
        },
      ),
    ),
  };

  /** The CRM's name for a checked field, learned from the linked updates' live checks. */
  function crmField(field: CheckedField): string {
    const name = crmFields.get(field);
    if (name === undefined) throw new Error(`no live check names the CRM's field for ${field}`);
    return name;
  }

  // ── 4. Twice ──

  const twice: CheckGroup = {
    id: "twice",
    title: "twice",
    checks: CASES.map((caseItem) =>
      check(
        `${caseItem.id}: each write executed twice leaves one record`,
        cantHold(caseItem),
        async () => {
          const world = await liveWorld();
          const plan = planOf(adapter().plan(caseInput(caseItem, world)), caseItem);
          const done: WriteOutcome[] = [];
          for (const write of plan.writes) {
            const first = await adapter().execute(write, done, ctx());
            const again = await adapter().execute(write, done, ctx());
            expect(same(again.ref), `write ${write.index} again`).toEqual(same(first.ref));
            expect(again.op, `write ${write.index} again`).toBe(againOp(write));
            done.push(first);
            if (write.op === "create") await expectOne(write, first);
            for (const link of write.associate) {
              const source =
                write.op === "associate" && write.ref ? outcomeRef(write.ref, done) : first.ref;
              const target = same(outcomeRef(link.to, done));
              const links = (await harness.associations(source)).map(same);
              expect(
                links.filter((item) => item.object === target.object && item.id === target.id),
                `write ${write.index}'s link, once`,
              ).toHaveLength(1);
            }
          }
        },
      ),
    ),
  };

  // ── 5. Lost responses ──

  const lost: CheckGroup = {
    id: "lost",
    title: "lost responses",
    checks: CASES.map((caseItem) =>
      check(
        `${caseItem.id}: a write whose answer is lost is found by reconcile, and the retry leaves one`,
        cantHold(caseItem),
        async () => {
          const world = await liveWorld();
          const plan = planOf(adapter().plan(caseInput(caseItem, world)), caseItem);
          const done: WriteOutcome[] = [];
          for (const write of plan.writes) {
            drop.next = true;
            const error = await thrownBy(() => adapter().execute(write, done, ctx())).finally(
              () => {
                drop.next = false;
              },
            );
            expect(error, `write ${write.index}, its answer lost`).toBeInstanceOf(CrmError);
            expect((error as CrmError).retryable, `write ${write.index}, its answer lost`).toBe(
              true,
            );
            const found = await adapter().reconcile(write, done, ctx());
            if (write.op === "create") {
              expect(found, `reconcile of write ${write.index}`).toMatchObject({
                index: write.index,
                op: "found",
              });
              await expectOne(write, found as WriteOutcome);
            } else if (found !== null) {
              expect(found.index, `reconcile of write ${write.index}`).toBe(write.index);
            }
            const retried = await adapter().execute(write, done, ctx());
            expect(retried.op, `write ${write.index}, retried`).toBe(againOp(write));
            if (found !== null) expect(same(retried.ref)).toEqual(same(found.ref));
            if (write.op === "create") await expectOne(write, retried);
            done.push(retried);
          }
        },
      ),
    ),
  };

  // ── 6. Live checks ──

  const MOVED: Readonly<Record<CheckedField, (world: CaseWorld, source: CrmSchema) => FieldValue>> =
    {
      stage: (world, source) =>
        source.stages.find(
          (stage) =>
            stage.stageId !== world.stage.stageId && stageSeen(stage) !== world.seen.deal.stage,
        )?.stageId ?? null,
      amount: () => 99_999,
      closeDate: () => "2027-02-26",
      title: () => "Chief of Staff",
      email: (world) => world.email.replace("priya.raman", "moved"),
      phone: () => "555-0199",
    };

  const liveCases = CASES.filter(
    (caseItem) =>
      caseItem.target === "linked" &&
      (caseItem.type === "deal_update" || caseItem.type === "contact"),
  );
  const live: CheckGroup = {
    id: "live",
    title: "live checks",
    checks: liveCases.map((caseItem) =>
      check(
        `${caseItem.id}: get reads each checked field as the plan compares it, and sees it move`,
        cantHold(caseItem),
        async () => {
          const world = await liveWorld();
          const plan = planOf(adapter().plan(caseInput(caseItem, world)), caseItem);
          const object = caseItem.type === "deal_update" ? "deal" : "contact";
          expect(plan.checks.map((item) => item.field).sort(), "the fields checked").toEqual(
            [...CHECKED_FIELDS[object]].sort(),
          );
          for (const item of plan.checks) {
            const record = await adapter().get(item.ref, [item.crmField], ctx());
            expect(record?.values[item.crmField], `${item.field} as the plan compares it`).toEqual(
              item.seen,
            );
            const value = MOVED[item.field as CheckedField](world, theSchema());
            const now = await harness.edit(item.ref, { field: item.field as CheckedField, value });
            const moved = await adapter().get(item.ref, [item.crmField], ctx());
            expect(now[item.field], `${item.field} after a CRM user moved it`).not.toEqual(
              item.seen,
            );
            expect(moved?.values[item.crmField], `${item.field} after a CRM user moved it`).toEqual(
              now[item.field],
            );
          }
        },
      ),
    ),
  };

  // ── 7. Errors ──

  const linkedContact = CASES.find((caseItem) => caseItem.id === "contact.linked") as Case;
  const linkedDeal = CASES.find((caseItem) => caseItem.id === "deal_update.linked") as Case;
  const newContact = CASES.find((caseItem) => caseItem.id === "contact.new") as Case;
  const refused = harness.refusedValue;
  const errors: CheckGroup = {
    id: "errors",
    title: "errors",
    checks: [
      check(
        "a 429 is rate_limited, with retry advice",
        needs("rateLimit", harness.respond !== undefined),
        async () => {
          harness.respond?.("rate_limited");
          const error = await thrownBy(() => adapter().verify(ctx()));
          expect(error).toBeInstanceOf(CrmError);
          expect(error).toMatchObject({ kind: "rate_limited", retryable: true });
          const wait = (error as CrmError).retryAfterMs;
          if (wait !== null) expect(wait).toBeGreaterThanOrEqual(0);
        },
      ),
      check(
        "a refused credential is auth",
        needs("auth", harness.refusedContext !== undefined),
        async () => {
          const refusedCtx = harness.refusedContext?.();
          if (!refusedCtx) return;
          const error = await thrownBy(() => adapter().verify(recording(refusedCtx, log, drop)));
          expect(error).toBeInstanceOf(CrmError);
          expect(error).toMatchObject({ kind: "auth", retryable: false });
        },
      ),
      check(
        "a deleted target is not_found: get reads null, and a write to it fails",
        cantHold(linkedDeal),
        async () => {
          const world = await liveWorld();
          const plan = planOf(adapter().plan(caseInput(linkedDeal, world)), linkedDeal);
          await harness.remove(world.deal.ref);
          expect(
            await adapter().get(world.deal.ref, [crmField("amount")], ctx()),
            "get of a deleted deal",
          ).toBeNull();
          const error = await thrownBy(() =>
            adapter().execute(plan.writes[0] as PlannedWrite, [], ctx()),
          );
          expect(error).toBeInstanceOf(CrmError);
          expect(error).toMatchObject({ kind: "not_found", retryable: false });
        },
      ),
      check(
        refused
          ? `a refused ${refused.field} is validation, naming the field`
          : "a refused value is validation, naming the field",
        needs("refusedValue", refused !== undefined),
        async () => {
          if (!refused) return;
          const world = await liveWorld();
          const caseItem = (CHECKED_FIELDS.contact as readonly string[]).includes(refused.field)
            ? linkedContact
            : linkedDeal;
          const plan = planOf(
            adapter().plan(caseInput(caseItem, world, { [refused.field]: refused.value })),
            caseItem,
          );
          const error = await thrownBy(() =>
            adapter().execute(plan.writes[0] as PlannedWrite, [], ctx()),
          );
          expect(error).toBeInstanceOf(CrmError);
          expect(error).toMatchObject({
            kind: "validation",
            field: refused.field,
            retryable: false,
          });
        },
      ),
      check(
        "a taken email is duplicate, with the record that holds it",
        needs("duplicates", true),
        async () => {
          const world = await liveWorld();
          const holder = await harness.make({
            object: "contact",
            name: "Dana Holder",
            title: "Director",
            email: world.email,
            phone: "555-0101",
            company: world.company.ref,
          });
          const plan = planOf(adapter().plan(caseInput(newContact, world)), newContact);
          const error = await thrownBy(() =>
            adapter().execute(plan.writes[0] as PlannedWrite, [], ctx()),
          );
          expect(error).toBeInstanceOf(CrmError);
          expect(error).toMatchObject({ kind: "duplicate", retryable: false });
          const existing = (error as CrmError).existing;
          expect(existing && same(existing), "the record that holds the email").toEqual(
            same(holder.ref),
          );
        },
      ),
    ],
  };

  // ── 8. Changes ──

  const changes: CheckGroup = {
    id: "changes",
    title: "changes",
    checks: [
      check(
        cannot.deletes
          ? `records made and edited come back in order, across page boundaries, none lost or repeated (deletes skipped: ${cannot.deletes})`
          : "records made, edited, and deleted come back in order, across page boundaries, none lost or repeated",
        null,
        async () => {
          const readAll = async (from: string | null) => {
            const seen: { ref: ExternalRef; kind: string; name: string | null; at: string }[] = [];
            let cursor = from;
            for (let page = 0; page < 1_000; page += 1) {
              const next = await adapter().changes(cursor, ctx());
              seen.push(
                ...next.changes.map((change) => ({
                  ref: change.ref,
                  kind: change.kind,
                  name: change.name,
                  at: change.at,
                })),
              );
              cursor = next.cursor;
              if (!next.more) return { seen, cursor };
            }
            throw new Error("changes never said there were no more");
          };
          const start = await readAll(null);
          const run = tag();
          const count = options.changesPageSize * 2 + 1;
          const made: ExternalRef[] = [];
          for (let index = 0; index < count; index += 1) {
            made.push(
              (await harness.make({ object: "company", name: `Changes ${run} ${index}` })).ref,
            );
          }
          const edited = made[1] as ExternalRef;
          await harness.edit(edited, { field: "name", value: `Changes ${run} edited` });
          const deleted = cannot.deletes ? null : (made[2] as ExternalRef);
          if (deleted) await harness.remove(deleted);

          const { seen } = await readAll(start.cursor);
          const ids = seen.map((change) => `${change.ref.object}:${change.ref.id}`);
          expect(ids.length - new Set(ids).size, "changes repeated in one pass").toBe(0);
          const times = seen.map((change) => Date.parse(change.at));
          expect(
            times.every((time, index) => index === 0 || time >= (times[index - 1] as number)),
            "changes in order",
          ).toBe(true);
          for (const ref of made) {
            const change = seen.find(
              (item) => item.ref.object === ref.object && item.ref.id === ref.id,
            );
            if (deleted && ref.id === deleted.id) {
              expect(change?.kind, "the deleted record").toBe("deleted");
            } else {
              expect(change?.kind, `record ${ref.id}`).toBe("changed");
            }
          }
          const editedChange = seen.find((item) => item.ref.id === edited.id);
          expect(editedChange?.name, "the edited record's new name").toBe(`Changes ${run} edited`);
        },
      ),
    ],
  };

  // ── 9. Limits and secrets ──

  const secret = harness.secret;
  const limits: CheckGroup = {
    id: "limits",
    title: "limits and secrets",
    checks: [
      check("no request exceeded the CRM's documented page and batch sizes", null, async () => {
        const over = log.sent.flatMap((request) => {
          const problem = options.limits(request);
          return problem === null ? [] : [`${request.method} ${request.url}: ${problem}`];
        });
        expect(over).toEqual([]);
      }),
      check(
        "no preview holds the credential, which shows as Bearer •••",
        secret === null ? "the CRM takes no credential" : null,
        async () => {
          if (secret === null) return;
          expect(log.previews.length, "previews made in this run").toBeGreaterThan(0);
          for (const preview of log.previews) {
            expect(holdsSecret(preview, secret), `${preview.method} ${preview.url}`).toBe(false);
            const authorization = preview.headers.authorization;
            if (authorization !== undefined) expect(authorization).toBe(CREDENTIAL_PREVIEW);
          }
        },
      ),
      check(
        "nothing thrown holds the credential, even from a CRM that quotes it back",
        secret === null
          ? "the CRM takes no credential"
          : needs("echo", harness.respond !== undefined),
        async () => {
          if (secret === null) return;
          harness.respond?.("echo_credential");
          await thrownBy(() => adapter().verify(ctx()));
          expect(log.thrown.length, "errors thrown in this run").toBeGreaterThan(0);
          for (const error of log.thrown) {
            expect(holdsSecret(error, secret), String(error)).toBe(false);
          }
        },
      ),
    ],
  };

  return {
    title: `conformance: ${options.name ?? provider}`,
    groups: [connection, plans, writes, twice, lost, live, errors, changes, limits],
    async setup() {
      await harness.setup?.();
      schema = await adapter().schema(ctx());
      for (const caseItem of CASES) {
        const index = CASES.indexOf(caseItem);
        const key = await idempotencyKey(testUuid(0x3100 + index), testUuid(0x7100 + index));
        const markers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((at) => marker(key, at)));
        goldenMarkers.set(caseItem.id, { key, markers });
      }
      // The CRM's names for the checked fields, from the linked updates' live checks.
      const probe = probeWorld(theSchema());
      for (const caseItem of [linkedDeal, linkedContact]) {
        const result = adapter().plan(caseInput(caseItem, probe));
        if (!result.ok) continue;
        for (const item of result.plan.checks)
          crmFields.set(item.field as CheckedField, item.crmField);
      }
    },
    async teardown() {
      await harness.teardown?.();
    },
  };

  /** A world with placeholder records and every field seen, for learning the CRM's field names. */
  function probeWorld(source: CrmSchema): CaseWorld {
    const { mapping, rep } = mappingFor(source);
    const stages = stagesOf(source, mapping.newDeals.pipelineId);
    const fixed = goldenMarkers.get(CASES[0]?.id ?? "") ?? { key: "0".repeat(64), markers: [] };
    return {
      schema: source,
      mapping,
      rep,
      company: {
        entityId: testUuid(0x6201),
        ref: { object: "company", id: "probe-company", url: null },
        name: "Probe",
      },
      contact: {
        entityId: testUuid(0x6202),
        ref: { object: "contact", id: "probe-contact", url: null },
        name: "Probe Person",
      },
      deal: {
        entityId: testUuid(0x6203),
        ref: { object: "deal", id: "probe-deal", url: null },
        name: "Probe deal",
      },
      seen: {
        contact: { title: "x", email: "x@example.test", phone: "x" },
        deal: { stage: stageSeen(stages.from), amount: 1, closeDate: "2026-01-01" },
      },
      stage: stages.to,
      email: "probe@example.test",
      proposalId: testUuid(0x3200),
      reviewId: testUuid(0x7200),
      key: fixed.key,
      markers: fixed.markers,
    };
  }
}
