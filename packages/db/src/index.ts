export { createHttpDb, createPoolDb, type HttpDb, type PoolDb } from "./client";
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
