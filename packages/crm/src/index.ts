// @earshot/crm: the CRM adapter SDK (Phase 6 spec §4.2 to §4.4, §4.9; docs/adr/0040, docs/adr/0041).
// WP1 holds its types, its errors, and the idempotency key and markers; WP2 adds the error mapping
// and redaction, shared planning, and the dry run's renderer here, and the reference CRM
// (`./testing`), the conformance suite (`./conformance`), and the demo CRM's adapter (`./demo`).
export type {
  CrmMapping,
  CrmObject,
  CrmProvider,
  ExternalRef,
  SyncErrorKind,
} from "@earshot/core";
export type {
  CallCost,
  Capabilities,
  ChangeCursor,
  ChangePage,
  ConnectionInfo,
  CrmAdapter,
  CrmAssociationType,
  CrmChange,
  CrmConnectionRef,
  CrmContext,
  CrmOwner,
  CrmProperty,
  CrmRecord,
  CrmSchema,
  CrmStage,
  CrmValue,
  IdempotencyMode,
  LiveCheck,
  MirrorRef,
  PlanInput,
  PlannedWrite,
  PlanRefusal,
  PlanResult,
  RenderContext,
  RequestPreview,
  WriteOutcome,
  WritePlan,
  WriteRef,
} from "./adapter";
export {
  CrmError,
  type CrmErrorOptions,
  type ErrorBody,
  type ErrorContext,
  errorFromResponse,
  type HeadersLike,
  networkError,
  parseRetryAfter,
  retryAfterMs,
} from "./errors";
export { idempotencyKey, MARKER_CHARS, MARKER_PREFIX, marker } from "./markers";
export * from "./plan";
export { CREDENTIAL_PREVIEW, holdsSecret, REDACTED, redact, redactCause } from "./redact";
export {
  checkSentences,
  outcomeRef,
  placeholderId,
  previewOf,
  previewRef,
  type RequestSpec,
  requestOf,
  resolvePreview,
  urlOf,
} from "./render";
