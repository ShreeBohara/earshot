// @earshot/crm: the CRM adapter SDK (Phase 6 spec §4.2, §4.4; docs/adr/0040). WP1 holds its
// types, its errors, and the idempotency key and markers; WP2 adds the planning helpers, the
// renderer, the reference CRM (`./testing`), and the conformance suite (`./conformance`).
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
export { CrmError, type CrmErrorOptions } from "./errors";
export { idempotencyKey, MARKER_CHARS, MARKER_PREFIX, marker } from "./markers";
