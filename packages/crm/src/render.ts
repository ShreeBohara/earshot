// The dry run (Phase 6 spec decision 18, §4.9; docs/adr/0041): "Preview the write" shows a plan as
// the exact requests the adapter would send, with the credential as `Bearer •••`, and its live
// checks in words. Pure, with no network and no key. An adapter describes each write's requests once
// (`RequestSpec`), and both its `requests()` (through `previewOf`) and its `execute` (through
// `requestOf`) build from that description, so what the rep previews is what's sent; the
// conformance suite holds the two to each other. A write that points at an earlier one shows that
// record's id as a placeholder until the earlier write has run.
import type { CrmMappedStage, ExternalRef, FieldValue } from "@earshot/core";
import type {
  CrmStage,
  CrmValue,
  LiveCheck,
  RenderContext,
  RequestPreview,
  WriteOutcome,
  WritePlan,
  WriteRef,
} from "./adapter";
import { CREDENTIAL_PREVIEW } from "./redact";

/** One request an adapter sends, relative to its connection's API base: what both forms come from. */
export interface RequestSpec {
  readonly method: RequestPreview["method"];
  /** The path under the API base, with its query: `/crm/objects/2026-09/notes?idProperty=…`. */
  readonly path: string;
  /** Headers besides the credential and the body's type, which are added as each form needs. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The JSON body, if any. */
  readonly body?: CrmValue | null;
}

/** The id an earlier write's record shows as until that write has run. */
export function placeholderId(index: number): string {
  return `(write-${index})`;
}

/** A request's full URL: the API base, without a trailing slash, then the path. */
export function urlOf(spec: Pick<RequestSpec, "path">, ctx: RenderContext): string {
  return `${ctx.connection.apiBase.replace(/\/+$/, "")}${spec.path}`;
}

/** Header names in lower case, so a preview and a request compare whatever their spelling. */
function lowerHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

/** A spec's headers as sent: its own, and the JSON body's type when it has a body. */
function sentHeaders(spec: RequestSpec): Record<string, string> {
  const headers = lowerHeaders(spec.headers);
  if (spec.body !== undefined && spec.body !== null) headers["content-type"] = "application/json";
  return headers;
}

/**
 * A request as the dry run shows it: its method, full URL, headers (with the credential as
 * `Bearer •••` when the CRM takes one), and body. Never a credential, since none is ever added.
 */
export function previewOf(
  spec: RequestSpec,
  ctx: RenderContext,
  options: { readonly credential: boolean },
): RequestPreview {
  const headers = sentHeaders(spec);
  if (options.credential) headers.authorization = CREDENTIAL_PREVIEW;
  return { method: spec.method, url: urlOf(spec, ctx), headers, body: spec.body ?? null };
}

/**
 * A request as `execute` sends it through `CrmContext.fetch`, which adds the credential: the same
 * method, URL, headers, and body the preview shows.
 */
export function requestOf(spec: RequestSpec, ctx: RenderContext): Request {
  const hasBody = spec.body !== undefined && spec.body !== null;
  return new Request(urlOf(spec, ctx), {
    method: spec.method,
    headers: sentHeaders(spec),
    ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
  });
}

/**
 * The record a write points at, for a preview: the record itself, or an earlier write's as a
 * placeholder (`(write-0)`) with that write's object.
 */
export function previewRef(ref: WriteRef, plan: Pick<WritePlan, "writes">): ExternalRef {
  if (!("write" in ref)) return ref;
  const earlier = plan.writes[ref.write];
  if (earlier === undefined) throw new RangeError(`the plan has no write ${ref.write}`);
  return { object: earlier.object, id: placeholderId(ref.write), url: null };
}

/**
 * The record a write points at, for `execute`: the record itself, or the one an earlier write's
 * outcome names. Throws when that write hasn't run, which is the caller's bug.
 */
export function outcomeRef(ref: WriteRef, done: readonly WriteOutcome[]): ExternalRef {
  if (!("write" in ref)) return ref;
  const outcome = done.find((candidate) => candidate.index === ref.write);
  if (outcome === undefined) throw new RangeError(`write ${ref.write} hasn't run yet`);
  return outcome.ref;
}

/**
 * A preview with each placeholder swapped for the id its write's outcome names: in the URL as
 * `encodeURIComponent` spells it (adapters encode a path's ids so), and as it is in the headers and
 * every string of the body. What the request looks like once those writes have run: the conformance
 * suite compares it with what `execute` sent.
 */
export function resolvePreview(
  preview: RequestPreview,
  done: readonly WriteOutcome[],
): RequestPreview {
  const ids = done.map((outcome) => [placeholderId(outcome.index), outcome.ref.id] as const);
  const swap = (text: string, encode: boolean): string => {
    let out = text;
    for (const [placeholder, id] of ids) {
      out = out.split(placeholder).join(encode ? encodeURIComponent(id) : id);
    }
    return out;
  };
  const walk = (value: CrmValue): CrmValue => {
    if (typeof value === "string") return swap(value, false);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return {
    method: preview.method,
    url: swap(preview.url, true),
    headers: Object.fromEntries(
      Object.entries(preview.headers).map(([name, value]) => [name, swap(value, false)]),
    ),
    body: preview.body === null ? null : walk(preview.body),
  };
}

/** How a check's field reads in a sentence. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  stage: "the stage",
  amount: "the amount",
  closeDate: "the close date",
  title: "the title",
  email: "the email",
  phone: "the phone number",
  name: "the name",
};

/** Whole dollars without cents, other sums with them: "$48,000", "$1,250.50". */
const DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A checked value as a sentence shows it: a stage by its label, an amount as money, none as empty. */
function valueWords(
  field: string,
  value: FieldValue,
  stages: readonly (CrmStage | CrmMappedStage)[],
): string {
  if (value === null) return "empty";
  if (field === "stage" && typeof value === "string") {
    const stage = stages.find((candidate) => candidate.stageId === value);
    return stage?.label ?? value;
  }
  if (field === "amount" && typeof value === "number") {
    return (Number.isInteger(value) ? DOLLARS : CENTS).format(value);
  }
  return String(value);
}

/**
 * A plan's live checks as the dry run says them: "Checks that the stage is still Discovery", one
 * sentence each, in order. A stage the CRM holds by id reads by its label among `stages`.
 */
export function checkSentences(
  checks: readonly LiveCheck[],
  options: { readonly stages?: readonly (CrmStage | CrmMappedStage)[] } = {},
): string[] {
  return checks.map((check) => {
    const field = FIELD_WORDS[check.field] ?? `the ${check.field}`;
    return `Checks that ${field} is still ${valueWords(check.field, check.seen, options.stages ?? [])}`;
  });
}
