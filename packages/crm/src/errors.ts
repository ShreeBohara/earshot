// The adapter SDK's error taxonomy (Phase 6 spec §4.2; docs/adr/0040, docs/adr/0041). Every adapter
// throws `CrmError` for a call that failed, and the outbox decides by its kind: retry a 429 or a
// passing failure, fail the job, or take the conflict path for a deleted record or a taken unique
// value. WP1 fixed the class; WP2 adds the mapping from HTTP responses to kinds
// (`errorFromResponse`), the retry advice a CRM gives (`retryAfterMs`), network failures
// (`networkError`), and redaction: a `CrmError`'s message and cause never carry a credential.
import type { ExternalRef, SyncErrorKind } from "@earshot/core";
import { redact, redactCause } from "./redact";

/** The kinds the outbox retries, unless an adapter says otherwise: a 429, and a passing failure. */
const RETRIED: ReadonlySet<SyncErrorKind> = new Set<SyncErrorKind>(["rate_limited", "transient"]);

/** The kinds that name a field: a refused value, or a plan that can't read one (as `checkSyncEvent`). */
const FIELD_KINDS: ReadonlySet<SyncErrorKind> = new Set<SyncErrorKind>([
  "validation",
  "unmapped",
  "unsupported",
]);

/**
 * A CRM's error code or category, as a sync failure may carry it (`checkSyncEvent`'s rule): letters,
 * digits, and `_.:-`, starting with a letter or digit, at most 64 characters. Never a message.
 */
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A proposal's field name, as a sync failure names one (`FieldName` in `@earshot/core`). */
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

export interface CrmErrorOptions {
  /** Whether to retry the call; by default, `rate_limited` and `transient` are, the rest aren't. */
  readonly retryable?: boolean;
  /** How long to wait before the next try, when the CRM said (`Retry-After`). */
  readonly retryAfterMs?: number | null;
  /** The HTTP status, when there was a response. */
  readonly status?: number | null;
  /** The CRM's error code or category, never its message. */
  readonly code?: string | null;
  /** The proposal's field a refused value or an unmapped one names, such as `closeDate`. */
  readonly field?: string | null;
  /** For `duplicate`: the record that already holds the value, which the conflict offers. */
  readonly existing?: ExternalRef | null;
  readonly cause?: unknown;
}

/**
 * A CRM call that failed, by the SDK's taxonomy: a 429 (`rate_limited`); a 5xx, a network error,
 * or a timeout (`transient`); a 401 or a revoked grant (`auth`); a 403 or a missing scope
 * (`forbidden`); a 404 (`not_found`); a 400 or 422 naming a field (`validation`); a unique value
 * already taken (`duplicate`); a plan's `unmapped` or `unsupported`; or anything else (`unknown`).
 * Its message is the adapter's own fixed words, never the CRM's message, which can quote a record,
 * and never a credential: the constructor redacts the message and makes the cause safe
 * (`redactCause`) all the same, and the conformance suite checks.
 */
export class CrmError extends Error {
  override readonly name = "CrmError";
  readonly kind: SyncErrorKind;
  /** Whether the outbox retries the call. */
  readonly retryable: boolean;
  /** How long to wait before the next try, when the CRM said; null otherwise. */
  readonly retryAfterMs: number | null;
  /** The HTTP status; null when there was no response. */
  readonly status: number | null;
  /** The CRM's error code or category; null when it gave none. */
  readonly code: string | null;
  /** The proposal's field to blame; null when there's none. */
  readonly field: string | null;
  /** For `duplicate`: the record that already holds the value; null otherwise. */
  readonly existing: ExternalRef | null;

  constructor(kind: SyncErrorKind, message: string, options: CrmErrorOptions = {}) {
    const cause = redactCause(options.cause);
    super(redact(message), cause === undefined ? undefined : { cause });
    const { retryAfterMs = null } = options;
    if (retryAfterMs !== null && !(Number.isFinite(retryAfterMs) && retryAfterMs >= 0)) {
      throw new RangeError("retryAfterMs is a time to wait: a finite number of ms, 0 or more");
    }
    this.kind = kind;
    this.retryable = options.retryable ?? RETRIED.has(kind);
    this.retryAfterMs = retryAfterMs;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.field = options.field ?? null;
    this.existing = options.existing ?? null;
  }
}

/** Headers as an adapter has them: a `Headers`, or a plain record. */
export type HeadersLike = Headers | Readonly<Record<string, string>>;

/** A whole number of seconds (RFC 9110's delay-seconds). */
const DELAY_SECONDS = /^\s*(\d{1,10})\s*$/;
/** An HTTP date in its preferred form, which ends `GMT` (RFC 9110's IMF-fixdate). */
const HTTP_DATE = /^\s*[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT\s*$/;

/**
 * The wait a `Retry-After` value asks for, in ms: a number of seconds, or an HTTP date (as Attio
 * sends it) less `now`, never below 0. Null when there's no value or it's neither form. HubSpot
 * sends none, so its 429s carry null and the outbox backs off on its own (from 10 s).
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const seconds = DELAY_SECONDS.exec(value);
  if (seconds) {
    const ms = Number(seconds[1]) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  if (!HTTP_DATE.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** `parseRetryAfter` of a response's `Retry-After` header. */
export function retryAfterMs(
  headers: HeadersLike | null | undefined,
  now = Date.now(),
): number | null {
  if (!headers) return null;
  return parseRetryAfter(headerOf(headers, "retry-after"), now);
}

function headerOf(headers: HeadersLike, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/**
 * What an adapter read from a CRM's error body: its code or category, the proposal's field it
 * names (the adapter maps the CRM's property name, `closedate`, to the field, `closeDate`), and,
 * for a taken unique value, the record that holds it. Never the CRM's message.
 */
export interface ErrorBody {
  readonly code?: string | null;
  readonly field?: string | null;
  readonly existing?: ExternalRef | null;
}

/** Where an error's words and its retry advice come from. */
export interface ErrorContext {
  /** The CRM's name, for the message ("HubSpot asked to slow down"); "The CRM" by default. */
  readonly crm?: string;
  /** Now in ms, for a `Retry-After` date; the clock by default. */
  readonly now?: number;
}

/**
 * The `CrmError` for a CRM's answer that wasn't a success, by §4.2's table:
 *
 * | Status | Kind |
 * |---|---|
 * | 429 | `rate_limited`, with the wait `Retry-After` asks for |
 * | 408, 5xx | `transient` (with `Retry-After`'s wait, when a 503 sends one) |
 * | 401, or a body coded `invalid_grant` | `auth` |
 * | 403 | `forbidden` (a missing scope, by the body's code) |
 * | 404, 410 | `not_found` |
 * | 409 | `duplicate`, with the record that holds the value |
 * | 400, 422 | `validation`, with the field |
 * | anything else | `unknown` |
 *
 * The message is fixed words; the code is kept only when it's shaped like one, and the field only
 * when it's a field name and the kind names fields, so a CRM's message can't ride along in either.
 */
export function errorFromResponse(
  status: number,
  body: ErrorBody = {},
  headers?: HeadersLike | null,
  context: ErrorContext = {},
): CrmError {
  const crm = context.crm ?? "The CRM";
  const code = typeof body.code === "string" && ERROR_CODE.test(body.code) ? body.code : null;
  const kind = kindOf(status, code);
  const field =
    FIELD_KINDS.has(kind) && typeof body.field === "string" && FIELD_NAME.test(body.field)
      ? body.field
      : null;
  const wait =
    kind === "rate_limited" || kind === "transient" ? retryAfterMs(headers, context.now) : null;
  return new CrmError(kind, messageOf(kind, crm, status), {
    status: Number.isInteger(status) ? status : null,
    code,
    field,
    retryAfterMs: wait,
    existing: kind === "duplicate" ? (body.existing ?? null) : null,
  });
}

function kindOf(status: number, code: string | null): SyncErrorKind {
  if (code === "invalid_grant") return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408 || (status >= 500 && status <= 599)) return "transient";
  switch (status) {
    case 401:
      return "auth";
    case 403:
      return "forbidden";
    case 404:
    case 410:
      return "not_found";
    case 409:
      return "duplicate";
    case 400:
    case 422:
      return "validation";
    default:
      return "unknown";
  }
}

function messageOf(kind: SyncErrorKind, crm: string, status: number): string {
  switch (kind) {
    case "rate_limited":
      return `${crm} asked to slow down`;
    case "transient":
      return `${crm} failed for a moment`;
    case "auth":
      return `${crm} refused the connection's credential`;
    case "forbidden":
      return `${crm} refused the call: the connection lacks a permission`;
    case "not_found":
      return `${crm} has no such record`;
    case "duplicate":
      return `${crm} already holds that value on another record`;
    case "validation":
      return `${crm} refused a value`;
    default:
      return `${crm} answered with status ${Number.isInteger(status) ? status : "unknown"}`;
  }
}

/**
 * A call that got no answer: a network failure or a timeout, `transient` and retried. The cause is
 * kept only as `redactCause` makes it safe, since a network error can quote the URL it failed on.
 */
export function networkError(cause: unknown, context: Pick<ErrorContext, "crm"> = {}): CrmError {
  return new CrmError("transient", `Couldn't reach ${context.crm ?? "the CRM"}`, { cause });
}
