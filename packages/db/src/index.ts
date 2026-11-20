export {
  type AccountExport,
  buildAccountExport,
  deleteSoleMemberWorkspaces,
  ensureWorkspace,
  personalWorkspaceName,
  soleMemberWorkspaceSessionIds,
} from "./account";
export {
  AUDIT_FORM_VERSION,
  type AuditChainExport,
  type AuditCheckpoint,
  type AuditCheckpointExport,
  type AuditEntryExport,
  type AuditEntryInput,
  type AuditHead,
  AuditHeadError,
  type AuditProblem,
  type AuditProblemKind,
  type AuditVerification,
  type AuditVerifyOptions,
  type AuditWorkspaceReport,
  escapeControls,
  exportAuditChain,
  type RecordedAudit,
  recordAudit,
  verifyAuditExport,
  writeCheckpoint,
  ZERO_HASH_HEX,
} from "./audit-chain";
export { createHttpDb, createPoolDb, type HttpDb, type PoolDb } from "./client";
export {
  DEMO_CRM_EXTERNAL_ID_PREFIX,
  type DemoCrmLoadResult,
  type DemoCrmStatus,
  demoCrmStatus,
  loadDemoCrm,
  removeDemoCrm,
} from "./demo-crm";
export {
  appendEvents,
  PgEventStore,
  type PgEventStoreOptions,
  readEvents,
  type TenantTransaction,
  UnknownSessionError,
} from "./event-store";
export { type DbHealth, readDbHealth, stampBranch } from "./health";
export { rebuildProjections, type SessionProjections } from "./projections";
export * as schema from "./schema";
export {
  currentTenant,
  resolveWorkspace,
  TENANT_ROLE,
  type TenantContext,
  tenantTables,
  withTenant,
} from "./tenant";
export {
  type CredentialMeta,
  type CredentialSlot,
  credentialContext,
  crmConnectionContext,
  deleteCredential,
  listCredentials,
  type PutCredentialInput,
  putCredential,
  revealCredential,
  VaultOffError,
  VaultOpenError,
} from "./vault";
export { type RotationReport, rotateVaultKey, VaultRotationError } from "./vault-rotation";
