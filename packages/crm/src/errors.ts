// The adapter SDK's error taxonomy (Phase 6 spec §4.2; docs/adr/0040). Every adapter throws
// `CrmError` for a call that failed, and the outbox decides by its kind: retry a 429 or a passing
// failure, fail the job, or take the conflict path for a deleted record or a taken unique value.
// WP2 adds the mapping from HTTP responses to kinds, and each CRM's retry advice.
import type { SyncErrorKind } from "@earshot/core";

/** The kinds the outbox retries, unless an adapter says otherwise: a 429, and a passing failure. */
const RETRIED: ReadonlySet<SyncErrorKind> = new Set<SyncErrorKind>(["rate_limited", "transient"]);

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
  readonly cause?: unknown;
}

/**
 * A CRM call that failed, by the SDK's taxonomy: a 429 (`rate_limited`); a 5xx, a network error,
 * or a timeout (`transient`); a 401 or a revoked grant (`auth`); a 403 or a missing scope
 * (`forbidden`); a 404 (`not_found`); a 400 or 422 naming a field (`validation`); a unique value
 * already taken (`duplicate`); a plan's `unmapped` or `unsupported`; or anything else (`unknown`).
 * Its message is the adapter's own fixed words, never the CRM's message, which can quote a record,
 * and never a credential (the conformance suite checks, WP2).
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

  constructor(kind: SyncErrorKind, message: string, options: CrmErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
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
  }
}
